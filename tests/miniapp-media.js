const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const { videoEncoding, videoEncodingProfile, videoDeliveryMode, receiveUpload, verifyVideoDelivery, processVideo, MAX_DELIVERY_BYTES } = require("../server/miniapp-media");

function info(duration, codec = "hevc", width = 1920, pixFmt = "yuv420p") {
  return { format: { duration: String(duration) }, streams: [
    { codec_type: "video", codec_name: codec, pix_fmt: pixFmt, width, height: 1080 },
    { codec_type: "audio", codec_name: "aac" }
  ] };
}

test("按时长计算 MP4 交付版码率；长视频不再误报 40 分钟限制", () => {
  assert.equal(videoEncoding(info(60)).bitrate, 2300);
  assert.equal(videoEncoding(info(600)).bitrate, 2300);
  assert.ok(videoEncoding(info(2400)).bitrate >= 350);
  assert.equal(videoEncoding(info(4007, "h264")).duration, 4007);
  assert.equal(videoEncoding(info(4007, "h264")).audioBitrate, 48);
  const twoHourClip = videoEncoding(info(7200, "hevc"));
  assert.equal(twoHourClip.audioBitrate, 32);
  assert.ok(twoHourClip.bitrate >= 120);
  assert.deepEqual(videoEncodingProfile(twoHourClip.bitrate), { maxDimension: 426, fps: 15 });
  assert.deepEqual(videoEncodingProfile(100), { maxDimension: 256, fps: 12 });
  assert.throws(() => videoEncodingProfile(69), /最低分辨率/);
  assert.throws(() => videoEncoding(info(7201)), /120 分钟/);
  assert.equal(videoEncoding({ format: {}, streams: [{ codec_type: "video", codec_name: "h264", duration: "600", width: 640, height: 480 }] }).duration, 600);
  assert.throws(() => videoEncoding({ format: {}, streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 480 }] }), /无法读取视频时长/);
  assert.throws(() => videoEncoding(info(600, "hevc", 8000)), /4K/);
});

test("兼容 MP4 按体积和码率选择压缩或整理封装；HEVC 必须转码", () => {
  const compatible = videoEncoding(info(4007, "h264"));
  assert.equal(videoDeliveryMode(compatible, 175 * 1024 * 1024), "copy");
  assert.equal(videoDeliveryMode(compatible, MAX_DELIVERY_BYTES), "encode");
  assert.equal(videoDeliveryMode(videoEncoding(info(600, "h264")), 180 * 1024 * 1024), "encode");
  assert.equal(videoDeliveryMode(videoEncoding(info(600, "h264")), 100 * 1024 * 1024), "copy");
  assert.equal(videoDeliveryMode(videoEncoding(info(600, "hevc")), 100 * 1024 * 1024), "encode");
  assert.equal(videoDeliveryMode(videoEncoding(info(600, "h264", 1920, "yuv422p")), 100 * 1024 * 1024), "encode");
  assert.equal(videoDeliveryMode(videoEncoding(info(7200, "hevc")), MAX_DELIVERY_BYTES), "encode");
});

test("小程序上传接口只接收一个名为 media 的文件，不信任扩展名", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniapp-upload-test-"));
  const request = name => {
    const req = new PassThrough();
    req.headers = { "content-type": "multipart/form-data; boundary=boundary123" };
    process.nextTick(() => req.end(`--boundary123\r\nContent-Disposition: form-data; name="${name}"; filename="claimed.mp4"\r\nContent-Type: video/mp4\r\n\r\nnot-a-real-video\r\n--boundary123--\r\n`));
    return req;
  };
  try {
    const result = await receiveUpload(request("media"), path.join(root, "valid"), "video");
    assert.equal((await fs.readFile(result.source, "utf8")), "not-a-real-video");
    await assert.rejects(() => receiveUpload(request("other"), path.join(root, "bad"), "video"), /一次上传一个素材/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("真实FFmpeg成片须通过编码、完整时长、索引、大小及抽样解码验收", { timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniapp-delivery-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = name => path.join(root, `${name}.mp4`);
  const ffmpeg = args => execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-filter_threads", "1", ...args, "-y"], { timeout: 30000 });
  const make = (target, extra = [], audio = true, faststart = true) => ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=6",
    ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=700:sample_rate=44100:duration=6"] : []),
    "-map", "0:v:0", ...(audio ? ["-map", "1:a:0"] : []),
    "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    ...(faststart ? ["-movflags", "+faststart"] : []), ...extra, target
  ]);
  const source = file("source");
  await make(source);
  await t.test("直接上传成品可同路径只读验收，返回真实大小且原件不变", async () => {
    const before = await fs.readFile(source), stat = await fs.stat(source);
    const result = await verifyVideoDelivery(source, source);
    assert.equal(result.size, stat.size);
    assert.ok(Math.abs(result.videoDuration - 6) < 0.1);
    assert.ok(Math.abs(result.audioDuration - 6) < 0.1);
    assert.deepEqual(await fs.readFile(source), before);
    await assert.rejects(() => processVideo(source, source), /独立原片/);
    assert.deepEqual(await fs.readFile(source), before);
  });
  await t.test("无声音原片允许无音轨成品，原片有声音不得丢失", async () => {
    const silent = file("silent"); await make(silent, [], false);
    assert.equal((await verifyVideoDelivery(silent, silent)).audioDuration, null);
    await assert.rejects(() => verifyVideoDelivery(source, silent), /AAC 音轨/);
  });
  await t.test("H264非yuv420p、非H264和非AAC音轨均拒绝", async () => {
    for (const [name, args] of [["wrong-pixel", ["-pix_fmt", "yuv444p"]], ["wrong-video", ["-c:v", "mpeg4"]], ["wrong-audio", ["-c:a", "libmp3lame"]]]) {
      const output = file(name); await make(output, args);
      await assert.rejects(() => verifyVideoDelivery(source, output), /H264\/yuv420p/);
    }
  });
  await t.test("容器、视频和音频时长分别校验，任意截短超过1秒均拒绝", async () => {
    for (const [name, args] of [
      ["short-all", ["-t", "4"]],
      ["short-video", ["-vf", "trim=duration=4"]],
      ["short-audio", ["-af", "atrim=duration=4"]]
    ]) {
      const output = file(name); await make(output, args);
      await assert.rejects(() => verifyVideoDelivery(source, output), /完整时长/);
    }
  });
  await t.test("截短未达到旧2%容差的长片也拒绝", async () => {
    const long = file("long-source"), shortened = file("long-shortened");
    for (const [target, duration] of [[long, "75"], [shortened, "73.75"]]) {
      await ffmpeg(["-stream_loop", "-1", "-i", source, "-t", duration, "-c", "copy", "-movflags", "+faststart", target]);
    }
    const sourceResult = await verifyVideoDelivery(long, long);
    const shortResult = await verifyVideoDelivery(shortened, shortened);
    const difference = sourceResult.duration - shortResult.duration;
    assert.ok(difference >= 1 && difference < sourceResult.duration * 0.02);
    await assert.rejects(() => verifyVideoDelivery(long, shortened), /完整时长/);
  });
  await t.test("缺少faststart或结构截断的MP4拒绝", async () => {
    const noIndex = file("no-faststart"); await make(noIndex, [], true, false);
    await assert.rejects(() => verifyVideoDelivery(source, noIndex), /首屏索引/);
    const truncated = file("truncated"); const buffer = await fs.readFile(source);
    await fs.writeFile(truncated, buffer.subarray(0, buffer.length - 500));
    await assert.rejects(() => verifyVideoDelivery(source, truncated));
  });
  await t.test("元数据和索引尚存但媒体payload损坏时拒绝ready", async () => {
    const broken = file("broken-payload"), bytes = await fs.readFile(source);
    const mdat = bytes.indexOf(Buffer.from("mdat")); assert.ok(mdat > 0);
    const payload = bytes.length - mdat - 4;
    bytes.fill(0, mdat + 4 + Math.floor(payload * 0.45), mdat + 4 + Math.floor(payload * 0.65));
    await fs.writeFile(broken, bytes);
    const { stdout } = await execute("ffprobe", ["-v", "error", "-show_streams", "-of", "json", broken]);
    const metadata = JSON.parse(stdout);
    assert.equal(metadata.streams.find(stream => stream.codec_type === "video").codec_name, "h264");
    await assert.rejects(() => verifyVideoDelivery(source, broken), /ffmpeg|解码/);
    await assert.rejects(() => processVideo(broken, file("broken-processed")));
    assert.deepEqual(await fs.readFile(broken), bytes);
  });
  await t.test("直接上传同样按实际文件大小硬卡190MiB，拒绝空成品", async () => {
    const large = file("large"), empty = file("empty");
    await fs.copyFile(source, large); await fs.truncate(large, MAX_DELIVERY_BYTES);
    await assert.rejects(() => verifyVideoDelivery(source, large), /小于200MB/);
    await fs.writeFile(empty, "");
    await assert.rejects(() => verifyVideoDelivery(source, empty), /小于200MB/);
  });
  await t.test("自动整理封装与转码均完成统一验收且保留原片", async () => {
    const before = await fs.readFile(source), copied = file("processed-copy");
    assert.equal(await processVideo(source, copied), (await fs.stat(copied)).size);
    await verifyVideoDelivery(source, copied);
    assert.deepEqual(await fs.readFile(source), before);
    const incompatible = file("process-input-mpeg4"), encoded = file("processed-encode");
    await make(incompatible, ["-c:v", "mpeg4", "-q:v", "1"]);
    const original = await fs.readFile(incompatible);
    assert.equal(await processVideo(incompatible, encoded), (await fs.stat(encoded)).size);
    await verifyVideoDelivery(incompatible, encoded);
    assert.deepEqual(await fs.readFile(incompatible), original);
  });
});
