const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openSopPdf, saveCaseMedia, openCaseDocument } = require("../utils/catalog-download");

const caseId = "case_ead7a3aa8b0aa2d9";
const image = { index: 0, type: "image", url: "https://proj2.likeduoduiyi.cn/silver-images/test.jpg" };
const video = { index: 1, type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/test.mp4" };

function catalogPage() {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve("../pages/catalog/index.js");
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values, done) { Object.assign(this.data, values); if (done) done(); } };
}

function fakeWx(options = {}) {
  const calls = [];
  const wxApi = {
    calls,
    env: { USER_DATA_PATH: "wxfile://user" },
    getStorageSync() { return options.guest ? null : { token: "test-token", user: { role: "member" } }; },
    request(request) {
      calls.push(["authorize", request.url, request.header, request.responseType]);
      if (request.url.endsWith(".pdf")) {
        const data = Uint8Array.from(Buffer.from("%PDF-1.3\nexample")).buffer;
        return request.success({ statusCode: options.pdfDenied ? 403 : 200, data });
      }
      request.success({ statusCode: options.denied ? 401 : 200, data: options.denied ? { error: "请先登录" } : { url: options.resultUrl || image.url } });
    },
    downloadFile(request) {
      calls.push(["download", request.url, request.header]);
      process.nextTick(() => request.success({ statusCode: 200, tempFilePath: "wxfile://temporary" }));
      return { onProgressUpdate(callback) { callback({ progress: 45 }); } };
    },
    saveFile(request) { calls.push(["save-file", request.tempFilePath]); request.success({ savedFilePath: "wxfile://saved" }); },
    openDocument(request) { calls.push(["open-document", request.filePath, request.fileType, request.showMenu]); request.success({}); },
    saveImageToPhotosAlbum(request) { calls.push(["save-image", request.filePath]); request.success({}); },
    saveVideoToPhotosAlbum(request) { calls.push(["save-video", request.filePath]); request.success({}); },
    getFileSystemManager() { return {
      unlink(request) { calls.push(["unlink", request.filePath]); },
      writeFile(request) { calls.push(["write-pdf", request.filePath, request.data.byteLength]); request.success({}); }
    }; }
  };
  return wxApi;
}

test("SOP 通过登录态下载真正 PDF，保存后打开带菜单的文档", async () => {
  const wxApi = fakeWx();
  let progress = 0;
  await openSopPdf(wxApi, "act_001", value => { progress = value; });
  assert.equal(progress, 100);
  assert.match(wxApi.calls[0][1], /\/activities\/act_001\/download\.pdf$/);
  assert.equal(wxApi.calls[0][2].Authorization, "Bearer test-token");
  assert.equal(wxApi.calls[0][3], "arraybuffer");
  assert.deepEqual(wxApi.calls.slice(1), [
    ["write-pdf", "wxfile://user/sop-act_001.pdf", 16],
    ["open-document", "wxfile://user/sop-act_001.pdf", "pdf", true]
  ]);
});

test("未登录和未开放 SOP 下载时均不保存文件", async () => {
  const guest = fakeWx({ guest: true });
  await assert.rejects(openSopPdf(guest, "act_001"), /登录/);
  assert.equal(guest.calls.length, 0);
  const denied = fakeWx({ pdfDenied: true });
  await assert.rejects(openSopPdf(denied, "act_001"), /暂未开放/);
  assert.equal(denied.calls.some(call => call[0] === "write-pdf"), false);
});

test("精彩案例照片和视频先鉴权记账，再保存到系统相册", async () => {
  const photo = fakeWx();
  await saveCaseMedia(photo, caseId, image);
  assert.match(photo.calls[0][1], /\/cases\/case_ead7a3aa8b0aa2d9\/download\?i=0&format=json$/);
  assert.equal(photo.calls[0][2].Authorization, "Bearer test-token");
  assert.equal(photo.calls[1][1], image.url);
  assert.ok(photo.calls.some(call => call[0] === "save-image"));
  const movie = fakeWx({ resultUrl: video.url });
  await saveCaseMedia(movie, caseId, video);
  assert.ok(movie.calls.some(call => call[0] === "save-video"));
});

test("案例游客、过期登录和素材地址变更均不会下载 CDN 文件", async () => {
  const guest = fakeWx({ guest: true });
  await assert.rejects(saveCaseMedia(guest, caseId, image), /登录/);
  const denied = fakeWx({ denied: true });
  await assert.rejects(saveCaseMedia(denied, caseId, image), /登录/);
  const changed = fakeWx({ resultUrl: image.url.replace("test.jpg", "other.jpg") });
  await assert.rejects(saveCaseMedia(changed, caseId, image), /已更新/);
  for (const wxApi of [guest, denied, changed]) assert.equal(wxApi.calls.some(call => call[0] === "download"), false);
});

test("案例文档可鉴权下载并在微信文档页打开", async () => {
  const doc = { index: 2, type: "document", url: "https://proj2.likeduoduiyi.cn/silver-case-documents/test.docx" };
  const wxApi = fakeWx({ resultUrl: doc.url });
  await openCaseDocument(wxApi, caseId, doc);
  assert.deepEqual(wxApi.calls.find(call => call[0] === "open-document"), ["open-document", "wxfile://saved", "docx", true]);
});

test("案例视频在竖屏播放器内打开，且全屏保持竖屏", () => {
  const wxml = fs.readFileSync(path.join(__dirname, "../pages/catalog/index.wxml"), "utf8");
  assert.match(wxml, /id="caseVideo\{\{item\.index\}\}" class="case-video"[^>]*direction="0"[^>]*object-fit="contain"[^>]*show-fullscreen-btn="false"/);
  assert.match(wxml, /bindtap="onCaseFullscreen">竖屏全屏播放/);
  assert.match(wxml, /bindtap="onCaseSave"/);
  assert.match(wxml, /bindtap="onSopPdf"/);
  assert.ok(wxml.indexOf("bindtap=\"onCaseSave\"") < wxml.indexOf("class=\"case-image\""), "保存入口在预览图之前");
  const calls = [];
  global.wx = { createVideoContext(id, page) {
    calls.push(["context", id, page]);
    return { requestFullScreen(options) { calls.push(["fullscreen", options]); } };
  } };
  const page = catalogPage();
  page.allMedia = [video];
  page.onCaseFullscreen({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.playingIndex, 1);
  assert.deepEqual(calls.map(call => call[0]), ["context", "fullscreen"]);
  assert.equal(calls[0][1], "caseVideo1");
  assert.equal(calls[0][2], page);
  assert.deepEqual(calls[1][1], { direction: 0 });
  delete global.wx;
});
