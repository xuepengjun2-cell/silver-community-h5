const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const { finished } = require("stream/promises");
const Busboy = require("busboy");

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 190 * 1024 * 1024;
const MAX_DELIVERY_BYTES = 190 * 1024 * 1024;
// Leave enough headroom below the hard 190 MiB limit for muxing/metadata while
// preserving as much quality as possible. Long clips trade resolution/fps for size.
const TARGET_DELIVERY_BYTES = 175 * 1024 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 2 * 60 * 60;

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
    let parser;
    let input;
    let output;
    let created = false;
    const detach = () => {
      req.removeListener("data", onData);
      req.removeListener("aborted", onAbort);
      req.removeListener("error", fail);
      req.removeListener("close", onClose);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      detach();
      req.unpipe(parser);
      // Wait for close before the caller releases its disk lease or removes
      // staging. An open, unlinked partial file still consumes disk space.
      Promise.resolve().then(async () => {
        if (input) { input.unpipe(output); input.destroy(); }
        if (parser) parser.destroy();
        if (output) output.destroy();
        if (writing) await writing.catch(() => {});
        if (created) await fsp.rm(source, { force: true });
      }).then(() => reject(error), cleanupError => reject(cleanupError));
      req.resume();
    };
    const onAbort = () => fail(new Error("上传已中断，请重试。"));
    const onClose = () => { if (req.complete === false) onAbort(); };
    let total = 0;
    const onData = chunk => {
      total += chunk.length;
      if (total > maxSize + 1024 * 1024) { fail(new Error("上传数据超出限制。")); req.destroy(); }
    };
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 10, fileSize: maxSize, fields: 1, fieldSize: 1024, parts: 10 } });
    } catch { return fail(new Error("上传格式错误，请从小程序重新选择素材。")); }
    parser.on("file", (name, file) => {
      count++;
      if (name !== "media" || count !== 1) { invalid = true; file.resume(); return; }
      input = file;
      file.on("error", fail);
      file.on("limit", () => { tooLarge = true; });
      output = fs.createWriteStream(source, { flags: "wx", mode: 0o600 });
      output.on("open", () => { created = true; });
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
    req.on("data", onData);
    req.on("aborted", onAbort);
    req.on("error", fail);
    req.on("close", onClose);
    parser.on("close", async () => {
      if (settled) return;
      try {
        if (writing) await writing;
        if (tooLarge) throw new Error(`素材过大：${type === "video" ? "视频须小于200MB" : "照片须小于50MB"}。`);
        if (invalid || count !== 1) throw new Error("请一次上传一个素材文件。 ");
        const stat = await fsp.stat(source);
        if (!stat.size || stat.size > maxSize) throw new Error("素材大小不符合要求。 ");
        if (!settled) { settled = true; detach(); resolve({ source, size: stat.size }); }
      } catch (error) { fail(error); }
    });
    if (req.aborted || req.destroyed) onAbort();
    else req.pipe(parser);
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
  const raw = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt,duration", "-of", "json", file], 30 * 1000);
  try { return JSON.parse(raw); }
  catch { throw new Error("无法识别媒体格式。 "); }
}

function videoEncoding(probed) {
  const video = (probed.streams || []).find(stream => stream.codec_type === "video");
  const audio = (probed.streams || []).find(stream => stream.codec_type === "audio");
  if (!video) throw new Error("文件中未识别到视频画面，请核对原片是否完整。 ");
  const durations = [probed.format?.duration, video.duration, audio?.duration].map(Number);
  const duration = durations.find(value => Number.isFinite(value) && value > 0);
  if (!duration) throw new Error("无法读取视频时长，请确认 MP4 原片完整且可正常播放。 ");
  if (duration > MAX_VIDEO_DURATION_SECONDS) throw new Error(`视频时长约 ${Math.ceil(duration / 60)} 分钟，超过 120 分钟处理上限，请分段上传。 `);
  if (Number(video.width) > 4096 || Number(video.height) > 4096) throw new Error("视频分辨率过大，请先降低到4K以内。 ");
  const audioBitrate = audio ? duration >= 90 * 60 ? 32 : duration > 40 * 60 ? 48 : 96 : 0;
  const bitrate = Math.min(2300, Math.floor(TARGET_DELIVERY_BYTES * 8 / duration / 1000 - audioBitrate));
  return { video, audio, duration, bitrate, audioBitrate };
}

function videoEncodingProfile(bitrate) {
  if (bitrate >= 700) return { maxDimension: 1280, fps: 25 };
  if (bitrate >= 350) return { maxDimension: 854, fps: 24 };
  if (bitrate >= 220) return { maxDimension: 640, fps: 20 };
  if (bitrate >= 120) return { maxDimension: 426, fps: 15 };
  if (bitrate >= 70) return { maxDimension: 256, fps: 12 };
  throw new Error("原视频码率过低，即使降到最低分辨率仍无法稳定交付，请分段上传或更换原片。 ");
}

function videoDeliveryMode(info, sourceSize) {
  // MP4 是封装格式，不代表内部编码必然兼容。接近目标体积且码率充足时压缩；
  // 已够小或长视频码率本就很低时仅整理索引，避免重复有损编码。
  const compatible = info.video.codec_name === "h264" && info.video.pix_fmt === "yuv420p" &&
    (!info.audio || info.audio.codec_name === "aac");
  if (compatible && sourceSize > 0 && sourceSize < MAX_DELIVERY_BYTES &&
      (sourceSize <= TARGET_DELIVERY_BYTES || info.bitrate < 350)) return "copy";
  return "encode";
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

function positiveDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Read MP4 top-level boxes without loading the video into memory. A complete
// moov box before mdat is required for playback before the whole file downloads.
async function verifyFaststart(file, size) {
  const handle = await fsp.open(file, "r");
  let offset = 0, moov = null, mdat = null, ftyp = false, boxes = 0;
  try {
    while (offset < size) {
      if (++boxes > 4096) throw new Error("视频 MP4 索引异常。 ");
      const header = Buffer.alloc(16);
      if ((await handle.read(header, 0, 8, offset)).bytesRead !== 8) throw new Error("视频 MP4 索引不完整。 ");
      let length = header.readUInt32BE(0), headerLength = 8;
      const type = header.toString("ascii", 4, 8);
      if (length === 1) {
        if ((await handle.read(header, 8, 8, offset + 8)).bytesRead !== 8) throw new Error("视频 MP4 索引不完整。 ");
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("视频 MP4 索引异常。 ");
        length = Number(extended); headerLength = 16;
      } else if (length === 0) length = size - offset;
      if (length < headerLength || offset + length > size) throw new Error("视频 MP4 文件已截断。 ");
      if (type === "ftyp") ftyp = true;
      if (type === "moov" && length > headerLength && moov === null) moov = offset;
      if (type === "mdat" && length > headerLength && mdat === null) mdat = offset;
      offset += length;
    }
  } finally { await handle.close(); }
  if (!ftyp || moov === null || mdat === null || moov > mdat) throw new Error("视频未通过 MP4 首屏索引校验，请重新处理后上传。 ");
}

async function verifyVideoDelivery(source, target) {
  const stat = await fsp.stat(target);
  if (!stat.isFile() || !stat.size || stat.size >= MAX_DELIVERY_BYTES) throw new Error("视频成品须小于200MB，请分段上传。 ");
  const input = await probe(source);
  const output = path.resolve(source) === path.resolve(target) ? input : await probe(target);
  const inputVideo = (input.streams || []).find(stream => stream.codec_type === "video");
  const inputAudio = (input.streams || []).find(stream => stream.codec_type === "audio");
  const videos = (output.streams || []).filter(stream => stream.codec_type === "video");
  const audios = (output.streams || []).filter(stream => stream.codec_type === "audio");
  if (!inputVideo || videos.length !== 1 || videos[0].codec_name !== "h264" || videos[0].pix_fmt !== "yuv420p" ||
      audios.length !== (inputAudio ? 1 : 0) || audios.some(stream => stream.codec_name !== "aac") ||
      !(output.format?.format_name || "").split(",").includes("mp4")) {
    throw new Error("视频成品须为 H264/yuv420p MP4，有声音时须保留 AAC 音轨。 ");
  }
  const duration = positiveDuration(output.format?.duration);
  const videoDuration = positiveDuration(videos[0].duration);
  const audioDuration = inputAudio ? positiveDuration(audios[0]?.duration) : null;
  const sourceDuration = positiveDuration(input.format?.duration);
  const sourceVideoDuration = positiveDuration(inputVideo.duration) || sourceDuration;
  const sourceAudioDuration = inputAudio ? positiveDuration(inputAudio.duration) || sourceDuration : null;
  const durations = [[sourceDuration || sourceVideoDuration, duration], [sourceVideoDuration, videoDuration]];
  if (inputAudio) durations.push([sourceAudioDuration, audioDuration]);
  if (durations.some(([before, after]) => !before || !after || Math.abs(before - after) >= 1)) {
    throw new Error("视频成品未保留原画面或声音的完整时长，请重新处理后上传。 ");
  }
  await verifyFaststart(target, stat.size);
  // Decode each track separately: a decodable video must not hide a broken AAC
  // track. Check the head, middle and tail of each track's own full duration.
  for (const [type, length] of [["v", videoDuration], ...(inputAudio ? [["a", audioDuration]] : [])]) {
    const sampleLength = Math.min(2, length);
    const points = [...new Set([0, Math.max(0, length / 2 - sampleLength / 2), Math.max(0, length - sampleLength)])];
    for (const point of points) {
      const decoded = await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-xerror", "-err_detect", "explode", "-ss", String(point), "-i", target,
        "-map", `0:${type}:0`, "-threads", "1", "-t", String(sampleLength),
        ...(type === "v" ? ["-progress", "pipe:1", "-f", "null", "-"] : ["-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"])
      ], 60 * 1000);
      if (type === "v" ? !/frame=\s*[1-9]\d*/.test(decoded) : !decoded.length) throw new Error("视频成品部分画面或声音无法解码，请重新上传。 ");
    }
  }
  const after = await fsp.stat(target);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error("视频成品在校验期间发生变化，请重新上传。 ");
  return { size: after.size, duration, videoDuration, audioDuration };
}

async function processVideo(source, target) {
  if (path.resolve(source) === path.resolve(target)) throw new Error("视频处理必须保留独立原片。 ");
  const input = videoEncoding(await probe(source));
  const sourceSize = (await fsp.stat(source)).size;
  const mode = videoDeliveryMode(input, sourceSize);
  const sourceBitrate = Math.floor(sourceSize * 8 * 0.9 / input.duration / 1000 - input.audioBitrate);
  // 已兼容的原视频只转封装并把索引移到文件头，避免重复有损编码。
  if (mode === "copy") {
    try {
      await run("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode", "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", target
      ], 10 * 60 * 1000);
      const copied = (await fsp.stat(target)).size;
      if (copied > 0 && copied < MAX_DELIVERY_BYTES) {
        return (await verifyVideoDelivery(source, target)).size;
      }
    } catch { /* 不可转封装时回退转码；原件仍保持不变。 */ }
    await fsp.rm(target, { force: true });
  }
  // 原片码率已低时不盲目把小文件放大；交付大小上限仍由最终校验决定。
  const bitrate = Math.floor(Math.min(input.bitrate, sourceBitrate));
  const profile = videoEncodingProfile(bitrate);
  await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-xerror", "-err_detect", "explode", "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", `scale=w='min(${profile.maxDimension},iw)':h='min(${profile.maxDimension},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${profile.fps}`,
    "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", "-b:v", `${bitrate}k`,
    "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`,
    "-c:a", "aac", "-b:a", `${input.audioBitrate || 64}k`, "-movflags", "+faststart", "-y", target
  ], Math.min(5 * 60 * 60 * 1000, Math.max(30 * 60 * 1000, input.duration * 2 * 1000 + 15 * 60 * 1000)));
  return (await verifyVideoDelivery(source, target)).size;
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
  receiveUpload, videoEncoding, videoEncodingProfile, videoDeliveryMode, verifyVideoDelivery, processImage, processVideo, processVideoPoster
};
