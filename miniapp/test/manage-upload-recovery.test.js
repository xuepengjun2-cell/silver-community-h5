"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SESSION_KEY } = require("../utils/auth");
const { MAX_VIDEO, uploadMedia } = require("../utils/upload");
const projectId = "project_85aae4b746069044";
const jobId = `miniapp_${"a".repeat(24)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(sharedStorage = new Map()) {
  const storage = sharedStorage, timers = new Map(), requests = [], pickers = [], uploads = [], modals = [], shares = [];
  let nextTimer = 0, definition;
  if (!storage.has(SESSION_KEY)) storage.set(SESSION_KEY, { token: "test-token", user: { id: "u_upload", role: "member" } });
  const project = { id: projectId, title: "活动", canManage: true, status: "published", shareEnabled: true, media: [] };
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    chooseMedia: options => pickers.push(options),
    compressImage: options => options.success({ tempFilePath: "/compressed.jpg" }),
    compressVideo: options => options.success({ tempFilePath: "/compressed.mp4" }),
    getFileInfo: options => options.success({ size: 1024 }),
    uploadFile(options) { uploads.push(options); options.success({ statusCode: 202, data: JSON.stringify({ jobId, status: "queued" }) }); return {}; },
    request(options) { if (options.url.endsWith(`/${projectId}`)) options.success({ statusCode: 200, data: { project } }); else requests.push(options); },
    showToast() {}, showModal: options => modals.push(options), navigateTo() {}, redirectTo() {},
    showShareMenu: () => shares.push("show"), hideShareMenu: () => shares.push("hide")
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../pages/manage/index.js"), "utf8"), {
    Page: value => { definition = value; }, wx,
    require: relative => require(path.resolve(__dirname, "../pages/manage", relative)),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  page.projectId = projectId;
  page.showProject(project);
  function select() { pickers.at(-1).success({ tempFiles: [{ tempFilePath: "/source-over-200mb.mp4" }] }); }
  async function start() { const pending = page.choose("video"); select(); await pending; await tick(); }
  return { page, wx, storage, requests, pickers, timers, uploads, modals, shares, select, start };
}

test("大原片仅上传客户端压缩产物；190MiB临界值禁止传原片", async () => {
  for (const size of [MAX_VIDEO - 1, MAX_VIDEO, MAX_VIDEO + 1]) {
    const f = fixture(); let selectedPath;
    f.wx.getFileInfo = options => options.success({ size });
    f.wx.uploadFile = options => { selectedPath = options.filePath; options.success({ statusCode: 202, data: JSON.stringify({ jobId }) }); return {}; };
    const pending = uploadMedia(f.wx, { projectId, source: "/source-over-200mb.mp4", type: "video", token: "t" });
    if (size < MAX_VIDEO) { await pending; assert.equal(selectedPath, "/compressed.mp4"); }
    else { await assert.rejects(pending, /分段上传/); assert.equal(selectedPath, undefined); }
  }
});

test("选择之前同步互斥，处理中的视频不能被第二次选择覆盖", async () => {
  const f = fixture();
  const first = f.page.choose("video"), second = f.page.choose("video");
  assert.equal(f.pickers.length, 1);
  f.select(); await Promise.all([first, second]); await tick();
  await f.page.choose("video");
  assert.equal(f.pickers.length, 1); assert.equal(f.uploads.length, 1);
  assert.equal(f.page.data.jobId, jobId);
});

test("处理查询短断网后退避继续，回来仍能确认ready", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().fail({ errMsg: "request:fail offline" }); await tick();
  assert.equal(f.page.data.jobId, jobId); assert.equal(f.timers.size, 1);
  const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.callback(); await tick();
  f.requests.shift().success({ statusCode: 200, data: { jobId, status: "ready" } }); await tick();
  assert.equal(f.page.data.jobId, ""); assert.equal(f.timers.size, 0);
  assert.match(f.page.data.progress, /可以分享/);
});

test("failed保留任务，重试复用后端原片且重复点击只发一次", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().success({ statusCode: 200, data: { jobId, status: "failed", error: "空间不足" } }); await tick();
  assert.equal(f.page.data.jobId, jobId); assert.equal(f.page.data.jobStatus, "failed");
  const first = f.page.onRetryVideo(), second = f.page.onRetryVideo();
  assert.equal(f.requests.length, 1); assert.match(f.requests[0].url, /\/retry$/); assert.equal(f.requests[0].method, "POST");
  f.requests.shift().success({ statusCode: 202, data: { jobId, status: "queued" } });
  await Promise.all([first, second]); await tick();
  assert.equal(f.uploads.length, 1); assert.equal(f.page.data.jobId, jobId);
});

test("离开页面后晚到poll不再设timer，按账号和相册隔离恢复任务", async () => {
  const f = fixture(); await f.start(); const late = f.requests.shift();
  f.page.onUnload();
  late.success({ statusCode: 200, data: { jobId, status: "processing" } }); await tick();
  assert.equal(f.timers.size, 0);
  const resumed = fixture(f.storage); resumed.page.onShow(); await tick();
  assert.equal(resumed.page.data.jobId, jobId); assert.equal(resumed.requests.length, 1);
  const other = fixture(f.storage); other.storage.set(SESSION_KEY, { token: "other", user: { id: "u_other", role: "member" } });
  other.page.onShow(); await tick(); assert.equal(other.page.data.jobId, ""); assert.equal(other.requests.length, 0);
  resumed.page.onUnload(); other.page.onUnload();
});

test("切后台暂停查询，回到前台只恢复一个轮询；连续断网退避封顶30秒", async () => {
  const f = fixture(); await f.start(); const late = f.requests.shift();
  f.page.onHide(); late.fail({ errMsg: "request:fail offline" }); await tick(); assert.equal(f.timers.size, 0);
  f.page.onShow(); f.page.onShow(); await tick(); assert.equal(f.requests.length, 1);
  const delays = [];
  for (let i = 0; i < 7; i++) {
    f.requests.shift().fail({ errMsg: "request:fail offline" }); await tick();
    assert.equal(f.timers.size, 1);
    const [id, timer] = [...f.timers][0]; delays.push(timer.delay); f.timers.delete(id); timer.callback(); await tick();
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  f.page.onUnload();
});

test("失败重试请求断网仍保存原job，下次可重试；失败任务返回前台也复核状态", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().success({ statusCode: 200, data: { status: "failed", error: "临时故障" } }); await tick();
  const retry = f.page.onRetryVideo();
  f.requests.shift().fail({ errMsg: "request:fail offline" }); await retry;
  assert.equal(f.page.data.jobId, jobId); assert.equal(f.page.data.jobStatus, "failed"); assert.equal(f.page.data.retrying, false);
  f.page.onHide(); f.page.onShow(); await tick(); assert.equal(f.requests.length, 1);
  f.requests.shift().success({ statusCode: 200, data: { status: "ready" } }); await tick();
  assert.equal(f.page.data.jobId, "");
});

test("已上传的晚到响应在卸载后仍存job；压缩期间离开则不开始网络上传", async () => {
  const f = fixture(); let transfer;
  f.wx.uploadFile = options => { transfer = options; return {}; };
  const pending = f.page.choose("video"); f.select(); await tick();
  f.page.onUnload(); transfer.success({ statusCode: 202, data: JSON.stringify({ jobId, status: "queued" }) }); await pending;
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
  const next = fixture(f.storage); next.page.onShow(); await tick(); assert.equal(next.page.data.jobId, jobId); next.page.onUnload();
  const preparing = fixture(); let compress;
  preparing.wx.compressVideo = options => { compress = options; };
  const prepare = preparing.page.choose("video"); preparing.select(); await tick(); preparing.page.onUnload();
  compress.success({ tempFilePath: "/compressed.mp4" }); await prepare;
  assert.equal(preparing.uploads.length, 0);
});

test("存储任务按相册隔离，不存token；ready前禁用按钮和菜单分享", async () => {
  const f = fixture(); await f.start();
  const saved = [...f.storage].find(([key]) => key !== SESSION_KEY);
  assert.ok(saved); assert.equal(JSON.stringify(saved).includes("test-token"), false);
  assert.equal(f.shares.at(-1), "hide");
  const other = fixture(f.storage); other.page.projectId = "project_0123456789abcdef";
  other.page.onShow(); await tick(); assert.equal(other.page.data.jobId, ""); other.page.onUnload();
  const wxml = fs.readFileSync(path.join(__dirname, "../pages/manage/index.wxml"), "utf8");
  assert.match(wxml, /busy \|\| jobId/); assert.match(wxml, /重试后台处理/);
  f.requests.shift().success({ statusCode: 200, data: { status: "ready" } }); await tick();
  assert.equal(f.shares.at(-1), "show"); assert.equal(f.storage.has(saved[0]), false);
});

test("失败后重选可替换任务，旧查询晚到ready不得清除新job", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().success({ statusCode: 200, data: { status: "failed", error: "原片需重选" } }); await tick();
  f.page.onShow(); await tick(); const oldQuery = f.requests.shift();
  const newer = `miniapp_${"b".repeat(24)}`;
  f.wx.uploadFile = options => { options.success({ statusCode: 202, data: JSON.stringify({ jobId: newer, status: "queued" }) }); return {}; };
  const upload = f.page.choose("video"); f.select(); await upload; await tick();
  oldQuery.success({ statusCode: 200, data: { status: "ready" } }); await tick();
  assert.equal(f.page.data.jobId, newer);
  assert.equal([...f.storage.values()].some(value => value && value.jobId === newer), true);
  assert.equal(f.shares.at(-1), "hide");
  f.page.onUnload();
});

test("查询401停止重试并保留任务供登录后恢复，不会无限请求失效token", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().success({ statusCode: 401, data: { error: "登录已失效" } }); await tick();
  assert.equal(f.timers.size, 0); assert.equal(f.storage.has(SESSION_KEY), false);
  assert.equal([...f.storage.values()].some(value => value && value.jobId === jobId), true);
});

test("失败记录复核为处理中时同步更新本地记录，不能按旧failed状态再传视频", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().success({ statusCode: 200, data: { status: "failed", error: "临时故障" } }); await tick();
  f.page.onHide(); f.page.onShow(); await tick();
  f.requests.shift().success({ statusCode: 200, data: { status: "processing" } }); await tick();
  await f.page.choose("video");
  assert.equal(f.pickers.length, 1); assert.equal(f.page.data.jobStatus, "processing");
  const saved = [...f.storage.values()].find(value => value && value.jobId === jobId);
  assert.equal(saved.status, "processing"); f.page.onUnload();
});

test("旧相册请求401和旧poll401都不能清除新账号或新token", async () => {
  const f = fixture(); let load;
  f.wx.request = options => { load = options; };
  const pending = f.page.load();
  const next = { token: "next-token", user: { id: "u_other", role: "member" } };
  f.storage.set(SESSION_KEY, next);
  load.success({ statusCode: 401, data: { error: "旧token已失效" } }); await pending;
  assert.equal(f.storage.get(SESSION_KEY), next);
  const g = fixture(); await g.start(); const oldPoll = g.requests.shift();
  const renewed = { token: "renewed-token", user: { id: "u_upload", role: "member" } };
  g.storage.set(SESSION_KEY, renewed);
  oldPoll.success({ statusCode: 401, data: { error: "旧token已失效" } }); await tick();
  assert.equal(g.storage.get(SESSION_KEY), renewed); assert.equal(g.timers.size, 0);
});

test("选择器和图片上传旧回调不能跨账号操作或覆盖新账号页面", async () => {
  const f = fixture();
  const picked = f.page.choose("image");
  f.storage.set(SESSION_KEY, { token: "other", user: { id: "u_other", role: "member" } });
  f.select(); await picked; assert.equal(f.uploads.length, 0);
  const g = fixture(); let response;
  g.wx.compressImage = options => options.success({ tempFilePath: "/compressed.jpg" });
  g.wx.uploadFile = options => { response = options; return {}; };
  const uploaded = g.page.choose("image"); g.select(); await tick();
  g.storage.set(SESSION_KEY, { token: "other", user: { id: "u_other", role: "member" } });
  g.page.data.project = { title: "新账号内容" };
  response.success({ statusCode: 201, data: JSON.stringify({ project: { title: "旧账号私密内容", media: [] } }) });
  await uploaded;
  assert.equal(g.page.data.project.title, "新账号内容");
});

test("retry发起即使旧poll失效，retrying期间返回前台不另发GET", async () => {
  const f = fixture(); await f.start();
  f.requests.shift().success({ statusCode: 200, data: { status: "failed", error: "临时故障" } }); await tick();
  f.page.onShow(); await tick(); const stalePoll = f.requests.shift();
  const retry = f.page.onRetryVideo(); const post = f.requests.shift();
  f.page.onHide(); f.page.onShow(); await tick(); assert.equal(f.requests.length, 0);
  stalePoll.success({ statusCode: 200, data: { status: "ready" } }); await tick();
  assert.equal(f.page.data.jobId, jobId);
  post.success({ statusCode: 202, data: { status: "queued", jobId } }); await retry; await tick();
  assert.equal(f.page.data.jobId, jobId); assert.equal(f.page.data.jobStatus, "processing");
  assert.equal(f.requests.length, 1); f.page.onUnload();
});

test("无法重试的failed可明确放弃，仅清本地记录并恢复原有相册分享", async () => {
  const f = fixture(); await f.start();
  const media = [{ type: "image", url: "https://proj2.likeduoduiyi.cn/silver-project-images/published.jpg" }];
  f.page.data.project.media = media;
  f.requests.shift().success({ statusCode: 200, data: { status: "failed", error: "原片已不可用" } }); await tick();
  f.page.onDiscardVideo();
  assert.equal(f.modals.length, 1); f.modals.at(-1).success({ confirm: false });
  assert.equal(f.page.data.jobId, jobId);
  f.page.onDiscardVideo(); f.modals.at(-1).success({ confirm: true });
  assert.equal(f.page.data.jobId, ""); assert.equal(f.shares.at(-1), "show");
  assert.equal([...f.storage.values()].some(value => value && value.jobId === jobId), false);
  assert.equal(f.page.data.project.media, media); assert.equal(f.requests.length, 0);
});


test("返回前台时换了token，旧相册请求未结束也会重载，避免永久停在loading", async () => {
  const f = fixture(), pending = [];
  f.wx.request = options => pending.push(options);
  const oldLoad = f.page.load();
  f.storage.set(SESSION_KEY, { token: "renewed-token", user: { id: "u_upload", role: "member" } });
  f.page.onShow();
  assert.equal(pending.length, 2);
  pending[0].success({ statusCode: 401, data: { error: "old token" } }); await oldLoad;
  assert.equal(f.storage.get(SESSION_KEY).token, "renewed-token");
  pending[1].success({ statusCode: 200, data: { project: { id: projectId, title: "current album", media: [], canManage: true } } }); await tick();
  assert.equal(f.page.data.loading, false); assert.equal(f.page.data.project.title, "current album");
});
