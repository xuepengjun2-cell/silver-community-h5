"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");
const { receiveUpload } = require("../server/miniapp-media");
const { createUploadServer, UPLOAD_REQUEST_TIMEOUT_MS } = require("../server/upload-transport");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const prefix = '--b\r\nContent-Disposition: form-data; name="media"; filename="x.mp4"\r\n\r\n';

test("HTTP receive budget exceeds wx ten-minute transfer budget and remains finite", () => {
  const server = createUploadServer(() => {});
  assert.equal(server.requestTimeout, UPLOAD_REQUEST_TIMEOUT_MS);
  assert.ok(server.requestTimeout > 600000 && server.requestTimeout <= 1800000);
  assert.equal(server.headersTimeout, 60000);
});

test("multipart interruption closes writer before rejecting and removes its partial file", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-upload-abort-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const req = new PassThrough();
  req.headers = { "content-type": "multipart/form-data; boundary=b" };
  const original = fs.createWriteStream;
  let writer;
  fs.createWriteStream = (...args) => (writer = original(...args));
  t.after(() => { fs.createWriteStream = original; req.destroy(); writer?.destroy(); });
  const received = receiveUpload(req, dir, "video");
  const rejected = assert.rejects(received, /上传已中断/);
  for (let i = 0; i < 100 && !req.listenerCount("aborted"); i++) await sleep(2);
  req.write(prefix + "partial payload");
  for (let i = 0; i < 100 && typeof writer?.fd !== "number"; i++) await sleep(2);
  assert.equal(typeof writer?.fd, "number");
  req.emit("aborted");
  await rejected;
  assert.equal(writer.destroyed, true);
  assert.equal(writer.closed, true);
  assert.equal(writer.fd, null);
  assert.equal(fs.existsSync(path.join(dir, "source")), false);
  assert.equal(req.listenerCount("aborted"), 0);
});

test("malformed multipart rejects and a preexisting source is never removed", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-upload-malformed-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const req = new PassThrough();
  req.headers = { "content-type": "multipart/form-data; boundary=b" };
  const result = receiveUpload(req, dir, "video");
  const rejected = assert.rejects(result, /Unexpected end/);
  await sleep(10);
  req.end(prefix + "broken");
  await rejected;
  assert.equal(fs.existsSync(path.join(dir, "source")), false);
  const second = new PassThrough();
  second.headers = req.headers;
  fs.writeFileSync(path.join(dir, "source"), "keep original");
  const existing = receiveUpload(second, dir, "video");
  const denied = assert.rejects(existing, /EEXIST/);
  await sleep(10);
  second.end(prefix + "replacement\r\n--b--\r\n");
  await denied;
  assert.equal(fs.readFileSync(path.join(dir, "source"), "utf8"), "keep original");
});

test("scaled socket total deadline rejects a continuously active slow upload with 408 and cleans source", { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-upload-deadline-"));
  let resolveOutcome;
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const server = createUploadServer(async (req, res) => {
    try { await receiveUpload(req, dir, "video"); res.end("unexpected success"); }
    catch (error) { resolveOutcome(error); if (!res.destroyed) res.end("failed"); }
  }, { requestTimeout: 160, headersTimeout: 100, connectionsCheckingInterval: 10 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = net.connect(server.address().port, "127.0.0.1");
  let response = "";
  socket.on("data", chunk => { response += chunk; });
  socket.on("error", () => {});
  t.after(async () => { socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.promises.rm(dir, { recursive: true, force: true }); });
  await once(socket, "connect");
  socket.write("POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: multipart/form-data; boundary=b\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n" + prefix);
  // Keep sending body data: this is a total-duration failure, not inactivity.
  const interval = setInterval(() => { if (!socket.destroyed) socket.write("active body chunk"); }, 15);
  t.after(() => clearInterval(interval));
  // The peer may reset while our interval is still writing after its 408.
  // Observe closure, then assert the HTTP status and server cleanup below.
  await new Promise(resolve => socket.once("close", resolve));
  const error = await outcome;
  assert.match(response, /HTTP\/1\.1 408/);
  assert.match(error.message, /中断|aborted/);
  assert.equal(fs.existsSync(path.join(dir, "source")), false);
});

test("scaled receive budget accepts a slow complete multipart within its deadline", { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-upload-complete-"));
  const server = createUploadServer(async (req, res) => {
    try { const result = await receiveUpload(req, dir, "video"); res.end(String(result.size)); }
    catch (error) { res.statusCode = 422; res.end(error.message); }
  }, { requestTimeout: 900, headersTimeout: 100, connectionsCheckingInterval: 10 });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const socket = net.connect(server.address().port, "127.0.0.1");
  let response = ""; socket.on("data", chunk => { response += chunk; });
  t.after(async () => { socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.promises.rm(dir, { recursive: true, force: true }); });
  await once(socket, "connect");
  const body = prefix + "complete payload\r\n--b--\r\n";
  socket.write(`POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: multipart/form-data; boundary=b\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n` + prefix);
  await sleep(200);
  socket.write("complete payload\r\n--b--\r\n");
  await once(socket, "close");
  assert.match(response, /HTTP\/1\.1 200/);
  assert.equal(fs.readFileSync(path.join(dir, "source"), "utf8"), "complete payload");
});
