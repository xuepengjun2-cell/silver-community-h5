const test = require("node:test");
const assert = require("node:assert/strict");
const { saveMedia } = require("../utils/save");

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
      if (request.url.endsWith("/download?i=0")) {
        return request.success({ statusCode: 200, data: { type: media.type, url: "https://tos.example.com/signed" } });
      }
      request.success({ statusCode: 200, data: { project: { id, media: [media] } } });
    },
    downloadFile(request) {
      calls.push(["download", request.url]);
      process.nextTick(() => request.success({ statusCode: 200, tempFilePath: "wxfile://tmp_demo" }));
      return { onProgressUpdate(callback) { callback({ progress: 56 }); } };
    },
    saveVideoToPhotosAlbum(request) {
      calls.push(["save-video", request.filePath]);
      saves += 1;
      if (options.denyOnce && saves === 1) request.fail({ errMsg: "saveVideoToPhotosAlbum:fail auth deny" });
      else request.success({});
    },
    saveImageToPhotosAlbum(request) {
      calls.push(["save-image", request.filePath]);
      request.success({});
    },
    showModal(request) { request.success({ confirm: true }); },
    openSetting(request) { request.success({ authSetting: { "scope.writePhotosAlbum": true } }); },
    getFileSystemManager() { return { unlink(request) { calls.push(["unlink", request.filePath]); } }; }
  };
  return wxApi;
}

test("公开 MP4 下载后直接保存到系统相册，不使用短时效 TOS 域名", async () => {
  const wxApi = fakeWx(video);
  let progress = 0;
  await saveMedia(wxApi, { projectId: id, index: 0, media: video, onProgress: p => { progress = p; } });
  assert.equal(progress, 56);
  assert.equal(wxApi.calls.filter(item => item[0] === "request").length, 2);
  assert.equal(wxApi.calls.find(item => item[0] === "download")[1], video.url);
  assert.ok(wxApi.calls.some(item => item[0] === "save-video"));
  assert.ok(wxApi.calls.some(item => item[0] === "unlink"));
  assert.equal(wxApi.calls[0][2].Authorization, undefined);
});

test("照片保存使用图片接口；用户首次拒绝权限后可从设置授权并重试", async () => {
  const photoWx = fakeWx(image);
  await saveMedia(photoWx, { projectId: id, index: 0, media: image });
  assert.ok(photoWx.calls.some(item => item[0] === "save-image"));
  const wxApi = fakeWx(video, { denyOnce: true });
  await saveMedia(wxApi, { projectId: id, index: 0, media: video });
  assert.equal(wxApi.calls.filter(item => item[0] === "save-video").length, 2);
});

test("相册关闭分享后不下载文件，MOV 不启动下载", async () => {
  const hidden = fakeWx(video, { hidden: true });
  await assert.rejects(saveMedia(hidden, { projectId: id, index: 0, media: video }), /相册未发布/);
  assert.equal(hidden.calls.some(item => item[0] === "download"), false);
  const mov = { ...video, url: video.url.replace(".mp4", ".mov") };
  const wxApi = fakeWx(mov);
  await assert.rejects(saveMedia(wxApi, { projectId: id, index: 0, media: mov }), /MP4/);
  assert.equal(wxApi.calls.length, 0);
});

test("存在服务端生成的 MP4 交付版时预览保留 MOV，保存下载 MP4", async () => {
  const original = {
    ...video,
    url: video.url.replace(".mp4", ".mov"),
    size: 800 * 1024 * 1024,
    delivery: { url: video.url, size: 85 * 1024 * 1024 }
  };
  const wxApi = fakeWx(original);
  await saveMedia(wxApi, { projectId: id, index: 0, media: original });
  assert.equal(wxApi.calls.find(item => item[0] === "download")[1], video.url);
});
