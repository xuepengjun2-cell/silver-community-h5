// 假的 @volcengine/tos-sdk：对象存放在 FAKE_TOS_DIR；上传和 HEAD 按 FAKE_TOS_DELAY_MS /
// FAKE_TOS_HEAD_DELAY_MS 延迟，拉长“等待 TOS 期间其他请求改动缓存”的窗口。预签名 GET 由本地 HTTP 服务提供。
const fs = require("fs");
const path = require("path");
const http = require("http");

const dir = process.env.FAKE_TOS_DIR;
const delay = () => new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_TOS_DELAY_MS || 0)));
const file = key => path.join(dir, encodeURIComponent(key));
let serverPort = 0;
const server = http.createServer((req, res) => {
  const key = decodeURIComponent(req.url.slice(1).split("?")[0]);
  if (!fs.existsSync(file(key))) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Length": fs.statSync(file(key)).size });
  fs.createReadStream(file(key)).pipe(res);
});
server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; });
server.unref();

class TosClient {
  constructor(config) { this.config = config; fs.mkdirSync(dir, { recursive: true }); }
  async putObjectFromFile({ key, filePath }) { await delay(); fs.copyFileSync(filePath, file(key)); return { data: {} }; }
  async putObject({ key, body }) { await delay(); fs.writeFileSync(file(key), body); return { data: {} }; }
  async headObject({ key }) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_TOS_HEAD_DELAY_MS || 0)));
    if (!fs.existsSync(file(key))) { const e = new Error("NoSuchKey"); e.statusCode = 404; throw e; }
    const size = String(fs.statSync(file(key)).size);
    return { data: { "content-length": size }, headers: { "content-length": size } };
  }
  async deleteObject({ key }) { fs.rmSync(file(key), { force: true }); return {}; }
  async createMultipartUpload() { return { data: { UploadId: "fake-upload" } }; }
  async abortMultipartUpload() { return {}; }
  getPreSignedUrl({ key }) { return `http://127.0.0.1:${serverPort}/${encodeURIComponent(key)}?sig=fake`; }
}

module.exports = { TosClient };
