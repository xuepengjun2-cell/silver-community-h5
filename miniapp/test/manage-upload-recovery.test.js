"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SESSION_KEY, getSession } = require("../utils/auth");
const config = require("../config");
const projectId = "project_85aae4b746069044";
const photo = name => ({ type: "image", url: `${config.imageBase}${name}.jpg`, title: name });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(sharedStorage = new Map()) {
  const storage = sharedStorage, requests = [], pickers = [], compressions = [], uploads = [], modals = [], shares = [], previews = [], toasts = [], redirects = [];
  let definition;
  if (!storage.has(SESSION_KEY)) storage.set(SESSION_KEY, { token: "test-token", user: { id: "u_upload", role: "member" } });
  const project = { id: projectId, title: "活动", canManage: true, status: "published", shareEnabled: true, media: [] };
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    chooseMedia: options => pickers.push(options),
    compressImage(options) { compressions.push(options); options.success({ tempFilePath: "/compressed.jpg" }); },
    getFileInfo: options => options.success({ size: 1024 }),
    uploadFile(options) { uploads.push(options); options.success({ statusCode: 201, data: JSON.stringify({ project: { ...project, media: [photo("uploaded")] } }) }); return {}; },
    request(options) { requests.push(options); options.success({ statusCode: 200, data: { project } }); },
    showToast: options => toasts.push(options), showModal: options => modals.push(options), navigateTo() {}, redirectTo: options => redirects.push(options),
    previewImage: options => previews.push(options),
    showShareMenu: () => shares.push("show"), hideShareMenu: () => shares.push("hide")
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../pages/manage/index.js"), "utf8"), {
    Page: value => { definition = value; }, wx,
    require: relative => require(path.resolve(__dirname, "../pages/manage", relative))
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  page.projectId = projectId;
  page.syncSession(getSession(wx));
  page.showProject(project);
  function select(files = [{ tempFilePath: "/photo.jpg", fileType: "image" }]) { pickers.at(-1).success({ tempFiles: files }); }
  async function start(files) { const pending = page.choose("image"); select(files); await pending; await tick(); }
  return { page, wx, storage, project, requests, pickers, compressions, uploads, modals, shares, previews, toasts, redirects, select, start };
}

function changeSession(f, sameUser = false) {
  const next = { token: "new-token", user: { id: sameUser ? "u_upload" : "u_other", role: "member" } };
  f.storage.set(SESSION_KEY, next);
  return next;
}

test("上传入口同步互斥，选择器只接收照片，完成后恢复分享", async () => {
  const f = fixture();
  const first = f.page.choose("image"), second = f.page.choose("image");
  assert.equal(f.pickers.length, 1);
  assert.deepEqual(Array.from(f.pickers[0].mediaType), ["image"]);
  assert.equal(f.pickers[0].count, 9);
  assert.equal(f.shares.at(-1), "hide");
  f.select(); await Promise.all([first, second]);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].filePath, "/compressed.jpg");
  assert.equal(f.page.data.busy, false); assert.equal(f.page.selecting, false);
  assert.equal(f.shares.at(-1), "show"); assert.equal(f.storage.size, 1);
});

test("旧入口直接传入非图片类型会在任何选择或请求前拒绝", async () => {
  const f = fixture();
  for (const type of ["video", "document", "", undefined]) await assert.rejects(f.page.choose(type), /仅支持上传照片/);
  assert.equal(f.pickers.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.compressions.length, 0); assert.equal(f.modals.length, 0);
});

test("选择器返回混合文件或矛盾类型时整批拒绝，不先上传前一张照片", async () => {
  for (const bad of [{ tempFilePath: "/clip.mp4", fileType: "video" }, { tempFilePath: "/clip.mp4", fileType: "image" },
    { tempFilePath: "/unknown.bin", fileType: "image" }, { tempFilePath: "/opaque" }, { tempFilePath: "/photo.jpg", fileType: "video" }]) {
    const f = fixture(); await f.start([{ tempFilePath: "/photo.jpg", fileType: "image" }, bad]);
    assert.equal(f.uploads.length, 0); assert.equal(f.compressions.length, 0);
    assert.equal(f.page.data.busy, false); assert.equal(f.shares.at(-1), "show");
    assert.match(f.modals[0].content, /仅支持上传照片/);
  }
});

test("只有选择器标明 image 的无扩展临时图片可继续实际图片压缩", async () => {
  const f = fixture(); await f.start([{ tempFilePath: "wxfile://tmp_opaque", fileType: "image" }]);
  assert.equal(f.compressions[0].src, "wxfile://tmp_opaque"); assert.equal(f.uploads.length, 1);
});

test("断网上传失败后释放锁，用户重新选择可成功且不存恢复视频任务", async () => {
  const f = fixture(), originalUpload = f.wx.uploadFile;
  f.wx.uploadFile = options => { f.uploads.push(options); options.fail({ errMsg: "uploadFile:fail offline" }); return {}; };
  await f.start();
  assert.equal(f.page.data.busy, false); assert.equal(f.page.selecting, false); assert.equal(f.shares.at(-1), "show");
  assert.match(f.modals[0].content, /offline|中断|网络/);
  f.wx.uploadFile = originalUpload; await f.start();
  assert.equal(f.uploads.length, 2); assert.equal(f.page.data.photos, 1); assert.equal(f.storage.size, 1);
});

test("选择器取消可立即重新选择，不展示失败弹窗", async () => {
  const f = fixture(), pending = f.page.choose("image");
  f.pickers[0].fail({ errMsg: "chooseMedia:fail cancel" }); await pending;
  assert.equal(f.page.data.busy, false); assert.equal(f.modals.length, 0);
  await f.start(); assert.equal(f.uploads.length, 1);
});

test("选择器晚返回和压缩期间卸载均不会开始上传", async () => {
  const f = fixture(), pending = f.page.choose("image"); f.page.onUnload(); f.select(); await pending;
  assert.equal(f.compressions.length, 0); assert.equal(f.uploads.length, 0);
  const g = fixture(); let compress;
  g.wx.compressImage = options => { compress = options; };
  const preparing = g.page.choose("image"); g.select(); await tick(); g.page.onUnload();
  compress.success({ tempFilePath: "/compressed.jpg" }); await preparing;
  assert.equal(g.uploads.length, 0); assert.equal(g.toasts.length, 0);
});

test("页面卸载后已发出的上传响应不覆盖页面、不发任务查询、不落任务存储", async () => {
  const f = fixture(); let transfer;
  f.wx.uploadFile = options => { transfer = options; f.uploads.push(options); return {}; };
  const pending = f.page.choose("image"); f.select(); await tick(); f.page.onUnload();
  const before = JSON.stringify(f.page.data);
  transfer.success({ statusCode: 201, data: JSON.stringify({ project: { ...f.project, title: "晚到", media: [photo("late")] } }) }); await pending;
  assert.equal(JSON.stringify(f.page.data), before); assert.equal(f.requests.length, 0); assert.equal(f.storage.size, 1); assert.equal(f.toasts.length, 0);
});

test("选择器回调不能跨账号或续验后的 token 发上传", async () => {
  for (const sameUser of [false, true]) {
    const f = fixture(), pending = f.page.choose("image"); changeSession(f, sameUser); f.select(); await pending;
    assert.equal(f.uploads.length, 0); assert.equal(f.compressions.length, 0);
    f.page.onShow(); await tick();
    assert.equal(f.page.data.busy, false); assert.equal(f.page.selecting, false); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].header.Authorization, "Bearer new-token");
  }
});

test("旧上传响应不能覆盖新账号项目或清除新操作的 busy 状态", async () => {
  const f = fixture(); let transfer;
  f.wx.uploadFile = options => { transfer = options; return {}; };
  const pending = f.page.choose("image"); f.select(); await tick(); changeSession(f);
  f.page.onShow(); await tick();
  f.page.showProject({ ...f.project, title: "新账号照片", media: [photo("new")] });
  const next = f.page.choose("image");
  transfer.success({ statusCode: 201, data: JSON.stringify({ project: { ...f.project, title: "旧账号内容", media: [photo("old")] } }) }); await pending;
  assert.equal(f.page.data.project.title, "新账号照片"); assert.equal(f.page.data.busy, true);
  f.pickers.at(-1).fail({ errMsg: "cancel" }); await next;
});

test("旧相册请求 401 不得注销新账号或新 token，前台重新读取能结束 loading", async () => {
  const f = fixture(), pending = [];
  f.wx.request = options => pending.push(options);
  const oldLoad = f.page.load(); const next = changeSession(f, true); f.page.onShow();
  assert.equal(pending.length, 2);
  pending[0].success({ statusCode: 401, data: { error: "旧token失效" } }); await oldLoad;
  assert.equal(f.storage.get(SESSION_KEY), next);
  pending[1].success({ statusCode: 200, data: { project: { ...f.project, title: "当前相册" } } }); await tick();
  assert.equal(f.page.data.loading, false); assert.equal(f.page.data.project.title, "当前相册");
});

test("同会话选择照片时回到前台不会重载并重置上传锁", async () => {
  const f = fixture(), pending = f.page.choose("image"); f.page.onShow();
  assert.equal(f.requests.length, 0); assert.equal(f.page.data.busy, true);
  f.select(); await pending;
});

test("上传成功后旧读取响应不能覆盖刚上传的照片", async () => {
  const f = fixture(); let read;
  f.wx.request = options => { read = options; };
  const loading = f.page.load(); await f.start();
  assert.equal(f.page.data.photos, 1);
  read.success({ statusCode: 200, data: { project: { ...f.project, media: [] } } }); await loading;
  assert.equal(f.page.data.photos, 1);
});

test("历史混排只展示照片，过滤后删除仍用原始下标，预览不含其它素材", async () => {
  const f = fixture();
  f.page.showProject({ ...f.project, cover: `${config.imageBase}cover.mp4`, secretMedia: "private-clip", media: [
    { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/clip.mp4" }, photo("first"),
    { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/second.mp4" }, photo("second")
  ] });
  assert.deepEqual(Array.from(f.page.data.tiles, tile => tile.index), [1, 3]);
  assert.equal(f.page.data.photos, 2); assert.equal(f.page.data.project.cover, photo("first").url);
  assert.equal(/mp4|private-clip|secretMedia/.test(JSON.stringify(f.page.data)), false);
  f.page.onPreview({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(Array.from(f.previews[0].urls), [photo("first").url, photo("second").url]);
  f.page.onDelete({ currentTarget: { dataset: { index: 3 } } });
  await f.modals[0].success({ confirm: true });
  assert.match(f.requests[0].url, /\/media\/3$/); assert.equal(f.requests[0].method, "DELETE");
});

test("伪造素材下标与只读账号不能触发删除或上传", async () => {
  const f = fixture(); f.page.showProject({ ...f.project, media: [{ type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/clip.mp4" }, photo("only")] });
  for (const index of [0, -1, 999, "NaN"]) {
    f.page.onDelete({ currentTarget: { dataset: { index } } }); f.page.onPreview({ currentTarget: { dataset: { index } } });
  }
  assert.equal(f.modals.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.previews.length, 0);
  f.page.showProject({ ...f.project, canManage: false, media: [photo("only")] });
  await f.page.choose("image"); f.page.onDelete({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.pickers.length, 0); assert.equal(f.modals.length, 0);
});

test("删除确认期间换账号或照片移动下标时不得用旧下标发出删除", async () => {
  for (const change of ["session", "index"]) {
    const f = fixture(); f.page.showProject({ ...f.project, media: [photo("first")] });
    f.page.onDelete({ currentTarget: { dataset: { index: 0 } } });
    if (change === "session") changeSession(f);
    else f.page.showProject({ ...f.project, media: [photo("changed")] });
    await f.modals[0].success({ confirm: true }); assert.equal(f.requests.length, 0);
  }
});

test("修改活动资料的晚到响应在卸载后不再修改页面", async () => {
  const f = fixture(); let patch;
  f.wx.request = options => { patch = options; };
  const pending = f.page.onSave(); f.page.onUnload();
  const before = JSON.stringify(f.page.data);
  patch.success({ statusCode: 200, data: { project: { ...f.project, title: "晚到资料" } } }); await pending;
  assert.equal(JSON.stringify(f.page.data), before);
});

test("管理页源码及模板没有播放器、文件外跳或历史任务恢复入口", () => {
  const source = fs.readFileSync(path.join(__dirname, "../pages/manage/index.js"), "utf8");
  const wxml = fs.readFileSync(path.join(__dirname, "../pages/manage/index.wxml"), "utf8");
  assert.doesNotMatch(source, /getVideoJob|retryVideoJob|pollJob|onVideo|createVideoContext|setClipboardData|videoPosterSources/);
  assert.doesNotMatch(wxml, /<video\b|上传视频|onVideo|jobId|playingIndex|<web-view\b/);
  assert.match(wxml, /media|照片/);
});
