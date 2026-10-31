// 假的 @volcengine/tos-sdk：对象存放在 FAKE_TOS_DIR；上传和 HEAD 按 FAKE_TOS_DELAY_MS /
// FAKE_TOS_HEAD_DELAY_MS 延迟，拉长“等待 TOS 期间其他请求改动缓存”的窗口。预签名 GET 由本地 HTTP 服务提供。
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto=require("crypto");
const etag=key=>crypto.createHash("md5").update(fs.readFileSync(file(key))).digest("hex");

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
  async putObjectFromFile({ key, filePath }) { await delay(); if (process.env.FAKE_TOS_REJECT_POSTER === "1" && key.startsWith("silver-images/")) throw new Error("test: poster storage unavailable"); fs.copyFileSync(filePath, file(key)); return { data: {} }; }
  async putObject({ key, body }) { await delay(); fs.writeFileSync(file(key), body); return { data: {} }; }
  async headObject({ key }) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_TOS_HEAD_DELAY_MS || 0)));
    if (!fs.existsSync(file(key))) { const e = new Error("NoSuchKey"); e.statusCode = 404; throw e; }
    const size = String(fs.statSync(file(key)).size);
    return { data: { "content-length": size, ETag:etag(key) }, headers: { "content-length": size, etag:etag(key) } };
  }
  async copyObject({key,srcKey,copySourceIfMatch}) {
    await delay();
    if(process.env.FAKE_TOS_MUTATE_COPY==='1')fs.writeFileSync(file(srcKey),Buffer.alloc(fs.statSync(file(srcKey)).size,0));
    if(process.env.FAKE_TOS_REJECT_COPY==='1')throw new Error('test: copy rejected');
    if(!copySourceIfMatch||etag(srcKey)!==copySourceIfMatch){const e=new Error('Source changed');e.statusCode=412;throw e;}
    fs.copyFileSync(file(srcKey),file(key));return {data:{ETag:etag(key)}};
  }
  async deleteObject({ key }) { fs.rmSync(file(key), { force: true }); return {}; }
  async createMultipartUpload() { const events=dir+'.initiations.json';const list=fs.existsSync(events)?JSON.parse(fs.readFileSync(events)):[];list.push('init');fs.writeFileSync(events,JSON.stringify(list));return { data: { UploadId: "fake-upload" } }; }
  async abortMultipartUpload() { return {}; }
  async listParts({ key }) {
    const metadata = `${file(key)}.parts.json`;
    return { data: { Parts: fs.existsSync(metadata) ? JSON.parse(fs.readFileSync(metadata, "utf8")) : [] } };
  }
  async completeMultipartUpload({ key }) {
    const parts = (await this.listParts({ key })).data.Parts.slice().sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));
    if (!parts.length) throw new Error("test: no multipart parts");
    const bodies = parts.map(part => {
      const body = fs.readFileSync(`${file(key)}.part-${part.PartNumber}`);
      if (body.length !== Number(part.Size) || !part.ETag) throw new Error("test: incomplete multipart fixture");
      return body;
    });
    fs.writeFileSync(file(key), Buffer.concat(bodies));
    return { data: {} };
  }
  getPreSignedUrl({ key }) { return `http://127.0.0.1:${serverPort}/${encodeURIComponent(key)}?sig=fake`; }
}

module.exports = { TosClient };
