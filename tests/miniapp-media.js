const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { videoEncoding, receiveUpload } = require("../server/miniapp-media");

function info(duration, codec = "hevc", width = 1920) {
  return { format: { duration: String(duration) }, streams: [
    { codec_type: "video", codec_name: codec, width, height: 1080 },
    { codec_type: "audio", codec_name: "aac" }
  ] };
}

test("按时长计算 MP4 交付版码率，不把 MOV 原片直接发布", () => {
  assert.equal(videoEncoding(info(60)).bitrate, 2300);
  assert.ok(videoEncoding(info(600)).bitrate < 2300);
  assert.throws(() => videoEncoding(info(2401)), /40分钟/);
  assert.throws(() => videoEncoding(info(600, "hevc", 8000)), /4K/);
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
