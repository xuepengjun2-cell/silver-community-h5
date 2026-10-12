const test = require("node:test");
const assert = require("node:assert/strict");
const { saveMedia, saveDownloadedMedia, downloadFile } = require("../utils/save");

const id = "project_85aae4b746069044";
const video = {
  type: "video", size: 1024,
  url: "https://proj2.likeduoduiyi.cn/silver-project-videos/sample.mp4"
};
const image = {
  type: "image", size: 1024,
  url: "https://proj2.likeduoduiyi.cn/silver-project-images/sample.jpg"
};

function fakeWx(media, options = {}) {
  const calls = [];
  let saves = 0;
  const wxApi = {
    calls,
    request(request) {
      calls.push(["request", request.url, request.header || {}]);
      if (options.hidden) return request.success({ statusCode: 404, data: { error: "not found" } });
      if (/\/download\?i=\d+$/.test(request.url)) {
        return request.success({ statusCode: 200, data: { type: options.returnedType || media.type, url: "https://tos.example.com/signed" } });
      }
      request.success({ statusCode: 200, data: { project: { id, media: options.media || [media] } } });
    },
    downloadFile(request) {
      calls.push(["download", request.url, request.timeout]);
      if (options.downloadFail) {
        process.nextTick(() => request.fail(options.downloadFail));
        return {};
      }
      process.nextTick(() => request.success({ statusCode: 200, tempFilePath: "wxfile://tmp_demo" }));
      return { onProgressUpdate(callback) { callback({ progress: 56 }); } };
    },
    saveImageToPhotosAlbum(request) {
      calls.push(["save-image", request.filePath]);
      saves += 1;
      if (options.saveFail) request.fail(options.saveFail);
      else if (options.denyOnce && saves === 1) request.fail({ errMsg: "saveImageToPhotosAlbum:fail auth deny" });
      else request.success({});
    },
    showModal(request) { calls.push(["modal"]); request.success({ confirm: options.allowSettings !== false }); },
    openSetting(request) { calls.push(["settings"]); request.success({ authSetting: { "scope.writePhotosAlbum": options.allowPermission !== false } }); },
    getFileSystemManager() { return { unlink(request) { calls.push(["unlink", request.filePath]); } }; }
  };
  return wxApi;
}

test("公开照片复核状态后使用 CDN 下载并保存，不使用短时效 TOS 地址", async () => {
  const wxApi = fakeWx(image);
  let progress = 0;
  await saveMedia(wxApi, { projectId: id, index: 0, media: image, onProgress: p => { progress = p; } });
  assert.equal(progress, 56);
  assert.equal(wxApi.calls.filter(item => item[0] === "request").length, 2);
  assert.equal(wxApi.calls.find(item => item[0] === "download")[1], image.url);
  assert.ok(wxApi.calls.some(item => item[0] === "save-image"));
  assert.ok(wxApi.calls.some(item => item[0] === "unlink"));
  assert.equal(wxApi.calls[0][2].Authorization, undefined);
});

test("照片权限被拒后可去设置授权重试，取消时及时回收临时文件", async () => {
  const wxApi = fakeWx(image, { denyOnce: true });
  await saveMedia(wxApi, { projectId: id, index: 0, media: image });
  assert.equal(wxApi.calls.filter(item => item[0] === "save-image").length, 2);
  assert.equal(wxApi.calls.filter(item => item[0] === "settings").length, 1);
  const declined = fakeWx(image, { denyOnce: true, allowSettings: false });
  await assert.rejects(saveMedia(declined, { projectId: id, index: 0, media: image }), /未取得相册权限/);
  assert.equal(declined.calls.filter(item => item[0] === "save-image").length, 1);
  assert.ok(declined.calls.some(item => item[0] === "unlink"));
});

test("相册关闭或图片被替换成视频后，不记录下载意图也不下载", async () => {
  const hidden = fakeWx(image, { hidden: true });
  await assert.rejects(saveMedia(hidden, { projectId: id, index: 0, media: image }), /相册未发布/);
  assert.equal(hidden.calls.some(item => item[0] === "download"), false);
  const changed = fakeWx(image, { media: [video] });
  await assert.rejects(saveMedia(changed, { projectId: id, index: 0, media: image }), /素材已更新/);
  assert.equal(changed.calls.length, 1);
  const removed = fakeWx(image, { media: [] });
  await assert.rejects(saveMedia(removed, { projectId: id, index: 0, media: image }), /素材已更新/);
  assert.equal(removed.calls.length, 1);
});

test("即使直接调用底层保存/下载，也在任何系统和网络调用前拒绝视频与伪装路径", async () => {
  const wxApi = fakeWx(video);
  await assert.rejects(saveMedia(wxApi, { projectId: id, index: 0, media: video }), /不可用/);
  await assert.rejects(saveDownloadedMedia(wxApi, "video", image.url), /不可用/);
  for (const url of [
    video.url, video.url + "?fake=.jpg", image.url.replace("sample.jpg", "sample.mp4.jpg"),
    image.url.replace("sample.jpg", "sample%2Emp4.jpg"), image.url.replace("sample.jpg", "sample.webp")
  ]) {
    await assert.rejects(saveDownloadedMedia(wxApi, "image", url), /不可用/);
    await assert.rejects(downloadFile(wxApi, url), /不可用/);
  }
  assert.equal(wxApi.calls.length, 0);
});

test("图片在视频后仍使用源数组 index 复核和记账，服务端类型变化阻止下载", async () => {
  const wxApi = fakeWx(image, { media: [video, image] });
  await saveMedia(wxApi, { projectId: id, index: 1, media: image });
  assert.match(wxApi.calls.filter(item => item[0] === "request")[1][1], /download\?i=1$/);
  const changed = fakeWx(image, { returnedType: "video" });
  await assert.rejects(saveMedia(changed, { projectId: id, index: 0, media: image }), /素材信息已变化/);
  assert.equal(changed.calls.some(item => item[0] === "download"), false);
});

test("底层保存支持经过案例鉴权的 JPG/PNG 地址，同时拒绝其他格式", async () => {
  const wxApi = fakeWx(image);
  const url = "https://proj2.likeduoduiyi.cn/silver/assets/case-photo.png";
  await saveDownloadedMedia(wxApi, "image", url);
  assert.equal(wxApi.calls.find(item => item[0] === "download")[1], url);
});

test("照片下载超时提示重试，未完成时不调用系统相册", async () => {
  const slow = fakeWx(image, { downloadFail: { errMsg: "downloadFile:fail timeout" } });
  await assert.rejects(saveMedia(slow, { projectId: id, index: 0, media: image }), /下载超时/);
  assert.equal(slow.calls.some(item => item[0] === "save-image"), false);
});

test("隐私指引未声明或用户未同意时，显示真实原因并避免误导去设置", async () => {
  const undeclared = fakeWx(image, { saveFail: { errno: 112, errMsg: "saveImageToPhotosAlbum:fail api scope is not declared in the privacy agreement" } });
  await assert.rejects(saveMedia(undeclared, { projectId: id, index: 0, media: image }), /用户隐私保护指引/);
  assert.equal(undeclared.calls.filter(item => item[0] === "save-image").length, 1);
  assert.equal(undeclared.calls.some(item => item[0] === "settings"), false);
  const declined = fakeWx(image, { saveFail: { errno: 104, errMsg: "saveImageToPhotosAlbum:fail privacy permission is not authorized" } });
  await assert.rejects(saveMedia(declined, { projectId: id, index: 0, media: image }), /同意/);
});
