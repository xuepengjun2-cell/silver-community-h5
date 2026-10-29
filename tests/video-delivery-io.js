const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");
const { ensureWorkingSpace, receiveRawVideo, downloadVideo } = require("../server/video-delivery-io");

test("原视频流有大小上限、写盘后核对长度", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-delivery-io-"));
  try {
    const request = new PassThrough();
    request.headers = { "content-length": "5" };
    const received = receiveRawVideo(request, path.join(root, "one", "source"), 10);
    request.end("hello");
    assert.equal(await received, 5);
    assert.equal(await fs.readFile(path.join(root, "one", "source"), "utf8"), "hello");

    const tooLarge = new PassThrough();
    tooLarge.headers = { "content-length": "11" };
    await assert.rejects(() => receiveRawVideo(tooLarge, path.join(root, "two", "source"), 10), /超过/);
    tooLarge.destroy();
    await ensureWorkingSpace(root, 1);
    await assert.rejects(() => ensureWorkingSpace(root, Number.MAX_SAFE_INTEGER), /空间不足/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("从受信对象地址流式下载并拒绝截断文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-delivery-download-"));
  const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "video/quicktime" }); res.end("video"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/source.mov`;
    assert.equal(await downloadVideo(url, path.join(root, "source"), 5, 10), 5);
    await assert.rejects(() => downloadVideo(url, path.join(root, "short"), 6, 10), /不完整/);
    await assert.rejects(() => downloadVideo(url, path.join(root, "oversize"), 11, 10), /大小不符合/);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("停止下载只终止本任务，拒绝前等待管道关闭", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-download-stop-"));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {"Content-Length": 1024 * 1024});
    const interval = setInterval(() => res.write(Buffer.alloc(1024)), 5);
    res.on('close', () => clearInterval(interval));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const controller = new AbortController();
    const reports = [];
    const pending = downloadVideo(`http://127.0.0.1:${server.address().port}/video`, path.join(root, 'source'), 1024 * 1024, 2 * 1024 * 1024, {
      signal: controller.signal,
      onProgress: event => { reports.push(event); controller.abort(); }
    });
    await assert.rejects(pending, error => error.code === 'VIDEO_TASK_ABORTED');
    assert.ok(reports.length > 0);
    assert.equal(reports[0].phase, 'downloading');
    assert.ok(reports.every(event => event.percent >= 0 && event.percent <= 99));
    const length = (await fs.stat(path.join(root,'source'))).size;
    await new Promise(resolve => setTimeout(resolve,20));
    assert.equal((await fs.stat(path.join(root,'source'))).size,length);
  } finally { server.closeAllConnections(); server.close(); await fs.rm(root,{recursive:true,force:true}); }
});

test("下载前已停止时不发请求，也不创建原片文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-download-prestop-"));
  let requests = 0;
  const server = http.createServer((_req,res)=>{requests++;res.end('hello');});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const controller=new AbortController();controller.abort();
    await assert.rejects(downloadVideo(`http://127.0.0.1:${server.address().port}/source`,path.join(root,'source'),5,10,{signal:controller.signal}),e=>e.code==='VIDEO_TASK_ABORTED');
    assert.equal(requests,0);
    await assert.rejects(fs.stat(path.join(root,'source')),e=>e.code==='ENOENT');
  } finally {server.closeAllConnections();server.close();await fs.rm(root,{recursive:true,force:true});}
});
