const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(initial = {}) {
  return Object.assign({ value: "", disabled: false, textContent: "", innerHTML: "", dataset: {}, handlers: {},
    addEventListener(event, handler) { this.handlers[event] = handler; }
  }, initial);
}

function loadPage(filename, exports) {
  const storage = new Map();
  const root = element();
  const context = vm.createContext({
    document: { querySelector: () => root, querySelectorAll: () => [] },
    location: { hostname: "localhost" },
    window: { location: { origin: "http://localhost" }, addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    URL, URLSearchParams, Set, console,
    setTimeout(callback) { callback(); return 1; }, clearTimeout() {},
    alert() {}, confirm: () => true
  });
  const source = fs.readFileSync(path.join(__dirname, "../public", filename), "utf8");
  vm.runInContext(source.replace(/^boot\(\);$/m, "") + `\nglobalThis.page = { ${exports.join(", ")} };`, context);
  return { context, storage };
}

function adminFixture() {
  const { context, storage } = loadPage("admin.js", ["state", "renderCaseEditor", "caseVideoDeliveryMedia", "caseUploadBlocksSave"]);
  const nodes = Object.fromEntries(["content", "caseBackBtn", "caseSaveBtn", "cTitle", "cCategory", "cCity", "cDate", "cDesc", "cStatus", "cSort", "cCoverUpload", "cCoverClear", "cMediaUpload", "cDocumentUpload", "cLinkAdd", "cUploadTip", "cVideoUploadTasks"].map(id => [`#${id}`, element()]));
  nodes["#cTitle"].value = "培训案例";
  nodes["#cStatus"].value = "published";
  context.document.querySelector = selector => nodes[selector] || null;
  context.document.querySelectorAll = selector => selector.startsWith("#cMediaUpload,") ? [nodes["#cMediaUpload"], nodes["#cDocumentUpload"], nodes["#cCoverUpload"], nodes["#cLinkAdd"]] : [];
  context.hydrateCaseAdminVideoThumbs = () => {};
  context.flash = () => {};
  context.renderCasesAdmin = () => {};
  const c = context.page.state.caseEdit = { id: "case-test", title: "培训案例", status: "published", media: [] };
  context.page.state.user = { id: "admin-test" };
  context.page.renderCaseEditor();
  const file = { name: "培训.mp4", type: "video/mp4", size: 250000000, lastModified: 1 };
  const change = () => nodes["#cMediaUpload"].handlers.change({ target: { files: [file], value: "file" } });
  return { context, storage, nodes, c, file, change };
}

const ready = { status: "ready", jobId: "job-test", url: "/uploads/delivery.mp4", poster: "/uploads/frame.jpg", size: 180000000, fingerprint: "hash" };

test("总部实际上传事件：处理中禁保存发布及重复选择，只在 ready 校验通过后入素材", async () => {
  const { context, nodes, c, change } = adminFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let uploads = 0, saves = 0;
  context.fetch = async () => { uploads++; await gate; return { ok: true, json: async () => ({ jobId: "job-test", status: "queued" }) }; };
  context.api = async url => { if (url.startsWith("/api/admin/video-jobs/")) return ready; saves++; return {}; };
  const uploading = change();
  assert.equal(c.uploadBusy, true);
  assert.equal(nodes["#caseSaveBtn"].disabled, true);
  assert.equal(nodes["#cMediaUpload"].disabled, true);
  await nodes["#caseSaveBtn"].handlers.click();
  await change();
  assert.equal(saves, 0, "程序触发保存也不能绕过处理中卡点");
  assert.equal(uploads, 1, "批次未完成不能并发重新上传");
  assert.equal(c.media.length, 0);
  release(); await uploading;
  assert.equal(c.media.length, 1);
  assert.equal(c.media[0].size, 180000000);
  assert.equal(c.media[0].poster, "/uploads/frame.jpg");
  assert.equal(c.uploadBusy, false);
  assert.equal(nodes["#caseSaveBtn"].disabled, false);
});

test("总部拒绝旧协议直传、超限成片、空大小和缺失封面，失败素材不进入发布列表", async () => {
  for (const result of [
    { ...ready, status: undefined }, { ...ready, status: "processing" },
    { ...ready, size: 200000000 }, { ...ready, size: 199229441 },
    { ...ready, size: 0 }, { ...ready, size: "NaN" }, { ...ready, poster: "" }, { ...ready, url: "" }
  ]) {
    const { context } = adminFixture();
    assert.throws(() => context.page.caseVideoDeliveryMedia(result));
  }
  const { context, c, change, nodes } = adminFixture();
  context.fetch = async () => ({ ok: true, json: async () => ({ ...ready, poster: "" }) });
  await change();
  assert.equal(c.media.length, 0);
  assert.match(nodes["#cVideoUploadTasks"].innerHTML, /处理失败，未加入案例/);
  assert.match(nodes["#cVideoUploadTasks"].innerHTML, /重新选择同一原文件可重试/);
});

test("恢复旧视频任务查询遇到网络异常时保留任务，不能自动重复上传原片", async () => {
  const { context, storage, c, file, nodes, change } = adminFixture();
  const key = `silver_case_video_job:admin-test:case-test:${file.name}:${file.size}:1`;
  storage.set(key, "existing-job");
  let uploads = 0;
  context.api = async () => { const error = new Error("临时网络异常"); error.status = 502; throw error; };
  context.fetch = async () => { uploads++; throw new Error("不应上传"); };
  await change();
  assert.equal(uploads, 0);
  assert.equal(storage.get(key), "existing-job");
  assert.equal(c.media.length, 0);
  assert.equal(nodes["#caseSaveBtn"].disabled, true);
  assert.match(nodes["#cVideoUploadTasks"].innerHTML, /查询处理结果/);
});

test("已失败且未入素材的任务不会永久阻塞其他已通过素材保存；未知和处理中任务继续阻塞", () => {
  const { context } = adminFixture();
  const blocks = context.page.caseUploadBlocksSave;
  assert.equal(blocks({ videoUploadTasks: { one: { status: "failed" } } }), false);
  assert.equal(blocks({ videoUploadTasks: { one: { status: "ready" } } }), false);
  for (const status of ["queued", "processing", "receiving", "pending", "unknown"]) assert.equal(blocks({ videoUploadTasks: { one: { status } } }), true);
});

test("相册仅把实际成片 media 验证通过的 completed/ready 计为成功，原片 fileSize 不可冒充成片大小", () => {
  const { context } = loadPage("app.js", ["state", "projectUploadOutcome"]);
  const outcome = context.page.projectUploadOutcome;
  assert.equal(outcome({ status: "processing", fileSize: 700000000 }, "video"), "processing");
  assert.equal(outcome({ status: "delivery_failed" }, "video"), "failed");
  assert.equal(outcome({ status: "completed", media: ready }, "video"), "published");
  assert.equal(outcome(ready, "video"), "published");
  assert.equal(outcome({ url: "photo.jpg" }, "image"), "published");
  for (const response of [
    { url: "original.mp4", size: 700000000 },
    { status: "completed", fileSize: 180000000, mediaUrl: "original.mp4" },
    { status: "completed", media: { ...ready, size: 200000000 } },
    { status: "completed", media: { ...ready, poster: "" } },
    { status: "completed", media: { ...ready, size: 0 } }
  ]) assert.throws(() => outcome(response, "video"));
});

test("相册上传、续传或后台处理中不能沉淀发布，状态读取失败时也保持卡点", () => {
  const { context } = loadPage("app.js", ["state", "projectUploadBlocksPromotion", "syncProjectUploadControls"]);
  const input = element(), promote = element();
  context.document.querySelector = selector => selector === "#projectFileInput" ? input : selector === "#projectPromoteBtn" ? promote : null;
  const state = context.page.state;
  state.projectUploading = true; context.page.syncProjectUploadControls();
  assert.equal(input.disabled, true); assert.equal(promote.disabled, true);
  state.projectUploading = false;
  for (const status of ["uploading", "processing", "queued", "receiving"]) {
    state.projectUploadSessions = [{ status }]; context.page.syncProjectUploadControls();
    assert.equal(promote.disabled, true); assert.equal(input.disabled, false);
  }
  state.projectUploadSessions = [{ status: "completed" }]; context.page.syncProjectUploadControls();
  assert.equal(promote.disabled, false);
  state.projectUploadSessionsError = "读取失败"; context.page.syncProjectUploadControls();
  assert.equal(promote.disabled, true);
});

test("相册实际批量上传事件：原片传完进入 processing 仍不统计成功，批次中不能再次上传或提前沉淀", async () => {
  const { context } = loadPage("app.js", ["state", "renderProjectManager"]);
  const nodes = Object.fromEntries(["projectFileInput", "projectPromoteBtn", "projectUploadProgress", "projectUploadSessions"].map(id => [`#${id}`, element()]));
  context.document.querySelector = selector => nodes[selector] || null;
  context.document.querySelectorAll = () => [];
  for (const fn of ["bindProjectVideoThumbs", "bindProjectDownloadEvents", "bindProjectUploadSessionActions", "scheduleProjectUploadPoll", "bindProjectShareEvents", "bindAuthEvents"]) context[fn] = () => {};
  context.projectHeader = () => "";
  context.loginModal = () => "";
  context.projectLightboxHtml = () => "";
  context.isMobileProjectDownload = () => false;
  const project = { id: "project-test", title: "测试相册", canManage: true, status: "published", shareEnabled: true, media: [] };
  context.page.state.user = { id: "admin-test", role: "admin" };
  context.page.renderProjectManager(project);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let uploads = 0, promotions = 0;
  context.uploadProjectMediaFile = async () => { uploads++; await gate; return { status: "processing", sessionId: "working" }; };
  context.api = async () => { promotions++; return {}; };
  context.loadProjectManager = async () => {
    context.page.state.projectUploadSessions = [{ status: "processing", title: "原片.mp4" }];
    context.page.renderProjectManager(project);
  };
  const change = () => nodes["#projectFileInput"].handlers.change({ target: { files: [{ name: "原片.mp4", type: "video/mp4", size: 500000000 }], value: "file" } });
  const running = change();
  assert.equal(nodes["#projectFileInput"].disabled, true);
  assert.equal(nodes["#projectPromoteBtn"].disabled, true);
  await nodes["#projectPromoteBtn"].handlers.click({ currentTarget: nodes["#projectPromoteBtn"] });
  await change();
  assert.equal(uploads, 1); assert.equal(promotions, 0);
  release(); await running;
  assert.match(nodes["#projectUploadProgress"].textContent, /0 项已通过校验并入相册/);
  assert.match(nodes["#projectUploadProgress"].textContent, /1 个视频后台处理中、尚未公开/);
  assert.equal(nodes["#projectFileInput"].disabled, false);
  assert.equal(nodes["#projectPromoteBtn"].disabled, true);
});
