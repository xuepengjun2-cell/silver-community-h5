const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const { finished } = require("stream/promises");
const Busboy = require("busboy");

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 190 * 1024 * 1024;
const MAX_DELIVERY_BYTES = 190 * 1024 * 1024;
const TARGET_DELIVERY_BYTES = 155 * 1024 * 1024;

async function receiveUpload(req, directory, type) {
  const maxSize = type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const source = path.join(directory, "source");
  return new Promise((resolve, reject) => {
    let count = 0;
    let tooLarge = false;
    let invalid = false;
    let writing = null;
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 10, fileSize: maxSize, fields: 1, fieldSize: 1024, parts: 10 } });
    } catch { return fail(new Error("上传格式错误，请从小程序重新选择素材。")); }
    parser.on("file", (name, file) => {
      count++;
      if (name !== "media" || count !== 1) { invalid = true; file.resume(); return; }
      file.on("limit", () => { tooLarge = true; });
      const output = fs.createWriteStream(source, { flags: "wx", mode: 0o600 });
      writing = finished(output);
      writing.catch(() => {}); // 中途断线也要消费流的 reject，避免未处理 Promise 异常。
      output.on("error", fail);
      file.pipe(output);
    });
    parser.on("partsLimit", () => { invalid = true; });
    parser.on("filesLimit", () => { invalid = true; });
    parser.on("fieldsLimit", () => { invalid = true; });
    parser.on("field", () => { invalid = true; });
    parser.on("error", fail);
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxSize + 1024 * 1024) { fail(new Error("上传数据超出限制。")); req.destroy(); }
    });
    req.on("aborted", () => fail(new Error("上传已中断，请重试。")));
    parser.on("close", async () => {
      try {
        if (writing) await writing;
        if (tooLarge) throw new Error(`素材过大：${type === "video" ? "视频须小于190MB" : "照片须小于50MB"}。`);
        if (invalid || count !== 1) throw new Error("请一次上传一个素材文件。 ");
        const stat = await fsp.stat(source);
        if (!stat.size || stat.size > maxSize) throw new Error("素材大小不符合要求。 ");
        if (!settled) { settled = true; resolve({ source, size: stat.size }); }
      } catch (error) { fail(error); }
    });
    req.pipe(parser);
  });
}

function run(command, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    // The shared production host must keep serving requests while FFmpeg runs.
    const lowered = process.platform === "linux" && command === "ffmpeg";
    const actualCommand = lowered ? "nice" : command;
    const actualArgs = lowered ? ["-n", "19", "ionice", "-c", "3", command, ...args] : args;
    const child = spawn(actualCommand, actualArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("视频处理超时，请尝试较短的片段。")); }, timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", error => finish(new Error(`${command} 不可用：${error.message}`)));
    child.on("close", code => finish(code === 0 ? null : new Error(`${command} 处理失败：${stderr.slice(-500)}`), stdout));
  });
}

async function probe(file) {
  const raw = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt", "-of", "json", file], 30 * 1000);
  try { return JSON.parse(raw); }
  catch { throw new Error("无法识别媒体格式。 "); }
}

function videoEncoding(probed) {
  const video = (probed.streams || []).find(stream => stream.codec_type === "video");
  const audio = (probed.streams || []).find(stream => stream.codec_type === "audio");
  const duration = Number(probed.format && probed.format.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 40 * 60) {
    throw new Error("视频无法解析或时长超过40分钟，请分段上传。 ");
  }
  if (Number(video.width) > 4096 || Number(video.height) > 4096) throw new Error("视频分辨率过大，请先降低到4K以内。 ");
  const bitrate = Math.min(2300, Math.floor(TARGET_DELIVERY_BYTES * 8 / duration / 1000 - (audio ? 96 : 0)));
  if (bitrate < 350) throw new Error("视频太长，压缩到可保存大小会明显失真，请分段上传。 ");
  return { video, audio, duration, bitrate };
}

async function processImage(source, target) {
  const info = await probe(source);
  const picture = (info.streams || []).find(stream => stream.codec_type === "video");
  if (!picture || !picture.width || !picture.height || picture.width > 10000 || picture.height > 10000) {
    throw new Error("图片格式或尺寸不支持，请上传普通照片。 ");
  }
  await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", source, "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "-frames:v", "1", "-q:v", "4", "-y", target], 2 * 60 * 1000);
  const stat = await fsp.stat(target);
  if (!stat.size || stat.size > 20 * 1024 * 1024) throw new Error("照片处理后仍过大。 ");
  return stat.size;
}

async function processVideo(source, target) {
  const input = videoEncoding(await probe(source));
  const sourceSize = (await fsp.stat(source)).size;
  const sourceBitrate = Math.floor(sourceSize * 8 * 0.9 / input.duration / 1000 - (input.audio ? 96 : 0));
  const verifiedOutput = async () => {
    const result = videoEncoding(await probe(target));
    if (result.video.codec_name !== "h264" || result.audio && result.audio.codec_name !== "aac" || Math.abs(result.duration - input.duration) > Math.max(1, input.duration * 0.02)) {
      throw new Error("生成的视频未通过格式或时长校验，请重新上传。 ");
    }
  };
  // 已兼容的原视频只转封装并把索引移到文件头，避免重复有损编码。
  if (input.video.codec_name === "h264" && input.video.pix_fmt === "yuv420p" && (!input.audio || input.audio.codec_name === "aac") &&
      (sourceSize < 5 * 1024 * 1024 || input.video.width <= 1280 && input.video.height <= 720 && sourceBitrate <= 2300) &&
      sourceSize < MAX_DELIVERY_BYTES) {
    try {
      await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", target
      ], 10 * 60 * 1000);
      const copied = (await fsp.stat(target)).size;
      if (copied > 0 && copied < MAX_DELIVERY_BYTES) {
        await verifiedOutput();
        return copied;
      }
    } catch { /* 不可转封装时回退转码；原件仍保持不变。 */ }
    await fsp.rm(target, { force: true });
  }
  // 原片码率已低时不盲目把小文件放大；交付大小上限仍由最终校验决定。
  const bitrate = Math.max(350, Math.min(input.bitrate, sourceBitrate));
  const maxWidth = bitrate < 700 ? 854 : 1280;
  const maxHeight = bitrate < 700 ? 480 : 720;
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", `scale=w='min(${maxWidth},iw)':h='min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=25`,
    "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", "-b:v", `${bitrate}k`,
    "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`,
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", target
  ], 90 * 60 * 1000);
  const stat = await fsp.stat(target);
  if (!stat.size || stat.size >= MAX_DELIVERY_BYTES) throw new Error("视频处理后仍超过190MB，请分段上传。 ");
  await verifiedOutput();
  return stat.size;
}

async function processVideoPoster(video, target) {
  // Decode the first actual video frame; never use a fake generic cover.
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-i", video,
    "-map", "0:v:0", "-frames:v", "1",
    "-vf", "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-q:v", "4", "-y", target
  ], 2 * 60 * 1000);
  const stat = await fsp.stat(target);
  if (!stat.size || stat.size > 3 * 1024 * 1024) throw new Error("视频首帧封面生成失败，请重试。 ");
  const info = await probe(target);
  if (!(info.streams || []).some(stream => stream.codec_name === "mjpeg" && stream.width > 0 && stream.height > 0)) {
    throw new Error("视频首帧封面未通过格式校验，请重试。 ");
  }
  return stat.size;
}

module.exports = {
  MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_DELIVERY_BYTES,
  receiveUpload, videoEncoding, processImage, processVideo, processVideoPoster
};
