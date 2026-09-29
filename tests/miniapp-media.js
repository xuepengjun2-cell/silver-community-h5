const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { videoEncoding, videoDeliveryMode, receiveUpload, MAX_DELIVERY_BYTES } = require("../server/miniapp-media");

function info(duration, codec = "hevc", width = 1920, pixFmt = "yuv420p") {
  return { format: { duration: String(duration) }, streams: [
    { codec_type: "video", codec_name: codec, pix_fmt: pixFmt, width, height: 1080 },
    { codec_type: "audio", codec_name: "aac" }
  ] };
}

test("按时长计算 MP4 交付版码率；长视频不再误报 40 分钟限制", () => {
  assert.equal(videoEncoding(info(60)).bitrate, 2300);
  assert.ok(videoEncoding(info(600)).bitrate < 2300);
  assert.ok(videoEncoding(info(2400)).bitrate >= 350);
  assert.equal(videoEncoding(info(4007, "h264")).duration, 4007);
  assert.equal(videoEncoding(info(4007, "h264")).audioBitrate, 64);
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
  assert.throws(() => videoDeliveryMode(videoEncoding(info(7200, "hevc")), MAX_DELIVERY_BYTES), /分段上传/);
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
