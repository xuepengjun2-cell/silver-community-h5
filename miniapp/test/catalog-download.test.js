const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openSopPdf, saveCaseMedia, openCaseDocument } = require("../utils/catalog-download");

const caseId = "case_ead7a3aa8b0aa2d9";
const image = { index: 0, type: "image", url: "https://proj2.likeduoduiyi.cn/silver-images/test.jpg" };
const video = { index: 1, type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/test.mp4" };

function fakeWx(options = {}) {
  const calls = [];
  const wxApi = {
    calls,
    getStorageSync() { return options.guest ? null : { token: "test-token", user: { role: "member" } }; },
    request(request) {
      calls.push(["authorize", request.url, request.header]);
      request.success({ statusCode: options.denied ? 401 : 200, data: options.denied ? { error: "请先登录" } : { url: options.resultUrl || image.url } });
    },
    downloadFile(request) {
      calls.push(["download", request.url, request.header]);
      process.nextTick(() => request.success({ statusCode: options.pdfDenied ? 403 : 200, tempFilePath: "wxfile://temporary" }));
      return { onProgressUpdate(callback) { callback({ progress: 45 }); } };
    },
    saveFile(request) { calls.push(["save-file", request.tempFilePath]); request.success({ savedFilePath: "wxfile://saved" }); },
    openDocument(request) { calls.push(["open-document", request.filePath, request.fileType, request.showMenu]); request.success({}); },
    saveImageToPhotosAlbum(request) { calls.push(["save-image", request.filePath]); request.success({}); },
    saveVideoToPhotosAlbum(request) { calls.push(["save-video", request.filePath]); request.success({}); },
    getFileSystemManager() { return { unlink(request) { calls.push(["unlink", request.filePath]); } }; }
  };
  return wxApi;
}

test("SOP 通过登录态下载真正 PDF，保存后打开带菜单的文档", async () => {
  const wxApi = fakeWx();
  let progress = 0;
  await openSopPdf(wxApi, "act_001", value => { progress = value; });
  assert.equal(progress, 45);
  assert.match(wxApi.calls[0][1], /\/activities\/act_001\/download\.pdf$/);
  assert.equal(wxApi.calls[0][2].Authorization, "Bearer test-token");
  assert.deepEqual(wxApi.calls.slice(1), [
    ["save-file", "wxfile://temporary"],
    ["open-document", "wxfile://saved", "pdf", true]
  ]);
});

test("未登录和未开放 SOP 下载时均不保存文件", async () => {
  const guest = fakeWx({ guest: true });
  await assert.rejects(openSopPdf(guest, "act_001"), /登录/);
  assert.equal(guest.calls.length, 0);
  const denied = fakeWx({ pdfDenied: true });
  await assert.rejects(openSopPdf(denied, "act_001"), /暂未开放/);
  assert.equal(denied.calls.some(call => call[0] === "save-file"), false);
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
  assert.match(wxml, /class="case-video"[^>]*direction="0"[^>]*object-fit="contain"/);
  assert.match(wxml, /bindtap="onCaseSave"/);
  assert.match(wxml, /bindtap="onSopPdf"/);
});
