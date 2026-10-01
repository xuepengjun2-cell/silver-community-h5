const test = require("node:test");
const assert = require("node:assert/strict");
const { SESSION_KEY } = require("../utils/auth");

function pageAt(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
}

test("普通启动直接显示登录表单，旧分享编号仍直接进匿名相册", async () => {
  const redirects = [];
  global.wx = { getStorageSync: () => null, redirectTo: value => redirects.push(value.url) };
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({});
  assert.equal(entry.data.loading, false);
  assert.deepEqual(redirects, []);
  await entry.onLoad({ id: "project_85aae4b746069044" });
  assert.deepEqual(redirects, ["/pages/album/index?id=project_85aae4b746069044"]);
  delete global.wx;
});

test("分享相册入口在任何登录检查前跳转，仅访问分享指定的相册", async () => {
  const redirects = [];
  global.wx = {
    getStorageSync() { throw new Error("相册分享不得读取平台登录态"); },
    login() { throw new Error("相册分享不得获取微信身份"); },
    request() { throw new Error("相册分享不得发起账号请求"); },
    redirectTo: value => redirects.push(value.url)
  };
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({ id: "project_85aae4b746069044" });
  assert.deepEqual(redirects, ["/pages/album/index?id=project_85aae4b746069044"]);
  delete global.wx;
});

test("微信新用户申请须先确认隐私指引，不会提前发起申请请求", async () => {
  let requests = 0;
  global.wx = { request() { requests++; } };
  const entry = pageAt("../pages/entry/index.js");
  await entry.onApply();
  assert.match(entry.data.error, /隐私保护指引/);
  assert.equal(requests, 0);
  delete global.wx;
});

test("旧会话过期后回到密码入口，不自动获取微信身份", async () => {
  const redirects = [];
  const storage = new Map([[SESSION_KEY, { token: "expired", user: { role: "viewer" } }]]);
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login() { throw new Error("进入页面不应调用 wx.login"); },
    redirectTo: value => redirects.push(value.url),
    request(options) {
      if (options.url.endsWith("/me")) return options.success({ statusCode: 401, data: { error: "登录已过期" } });
      throw new Error(`unexpected request: ${options.url}`);
    }
  };
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({});
  assert.equal(storage.has(SESSION_KEY), false);
  assert.equal(entry.data.loading, false);
  assert.equal(entry.data.wechatStatus, "idle");
  assert.deepEqual(redirects, []);
  delete global.wx;
});

test("任何微信状态下，普通密码登录均不绑定微信，总部管理员仍可登录", async () => {
  for (const status of ["idle", "unbound", "pending", "unavailable", "password-required", "disabled"]) {
    const calls = [];
    const storage = new Map();
    global.wx = {
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      login() { throw new Error("密码登录不应调用 wx.login"); },
      request(options) {
        calls.push(options);
        options.success({ statusCode: 200, data: { token: "platform-token", user: { id: "hq-original", role: "admin" } } });
      },
      redirectTo: value => calls.push(value)
    };
    const entry = pageAt("../pages/entry/index.js");
    entry.setData({ wechatStatus: status, username: " headquarters ", password: "platform-secret" });
    await entry.onSubmit();
    assert.equal(calls[0].url.endsWith("/login"), true, status);
    assert.deepEqual(calls[0].data, { username: "headquarters", password: "platform-secret" });
    assert.equal(storage.get(SESSION_KEY).user.id, "hq-original");
    assert.equal(entry.data.password, "");
    delete global.wx;
  }
});

test("只有明确选择绑定才绑定原账号，取消绑定后恢复密码登录", async () => {
  const calls = [];
  const storage = new Map();
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login: options => options.success({ code: "bind-code" }),
    request(options) {
      calls.push(options);
      options.success({ statusCode: 200, data: { token: "bound-token", user: { id: "u_existing", role: "member" } } });
    },
    redirectTo() {}
  };
  const entry = pageAt("../pages/entry/index.js");
  entry.setData({ wechatStatus: "unbound", username: "existing", password: "cleared-on-binding" });
  entry.onBindOpen();
  assert.equal(entry.data.authMode, "bind");
  assert.equal(entry.data.password, "");
  assert.equal(calls.length, 0);
  entry.setData({ password: "original-secret" });
  await entry.onSubmit();
  assert.equal(calls[0].url.endsWith("/auth/wechat/bind"), true);
  assert.equal(storage.get(SESSION_KEY).user.id, "u_existing");
  entry.onCancelWechat();
  assert.equal(entry.data.authMode, "password");
  assert.equal(entry.data.password, "");
  entry.setData({ password: "original-secret" });
  await entry.onSubmit();
  assert.equal(calls[1].url.endsWith("/login"), true);
  delete global.wx;
});

test("点击微信登录才获取 code；未绑定状态不建立平台会话", async () => {
  const requests = [];
  let loginCalls = 0;
  const storage = new Map();
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login(options) { loginCalls++; options.success({ code: "clicked-code" }); },
    request(options) { requests.push(options); options.success({ statusCode: 200, data: { status: "unbound", fingerprint: "a1b2c3d4e5f6" } }); },
    redirectTo() {}
  };
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({});
  assert.equal(loginCalls, 0);
  assert.equal(requests.length, 0);
  await entry.onWechatRetry();
  assert.equal(loginCalls, 1);
  assert.equal(requests[0].url.endsWith("/auth/wechat/session"), true);
  assert.equal(entry.data.wechatStatus, "unbound");
  assert.equal(storage.has(SESSION_KEY), false);
  entry.onCancelWechat();
  assert.equal(requests.length, 1);
  assert.equal(entry.data.wechatFingerprint, "");
  delete global.wx;
});

test("平台新申请无需微信服务，成功仅进入待审批提示而不建立登录态", async () => {
  const storage = new Map();
  const requests = [];
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login() { throw new Error("平台申请不应依赖微信服务"); },
    request(options) { requests.push(options); options.success({ statusCode: 201, data: { ok: true } }); }
  };
  const entry = pageAt("../pages/entry/index.js");
  entry.setData({ wechatStatus: "unavailable" });
  entry.onPlatformApplyOpen();
  entry.setData({ applicantUsername: "new-host", applicantPassword: "host-secret", applicantName: "新主办方", applicantContact: "13800000000", applicantAgreed: true });
  await entry.onApply();
  assert.equal(requests[0].url.endsWith("/register"), true);
  assert.equal(requests[0].data.username, "new-host");
  assert.equal(storage.has(SESSION_KEY), false);
  assert.match(entry.data.applicationMessage, /总部核实并开通/);
  assert.equal(entry.data.applicantPassword, "");
  delete global.wx;
});

test("微信新申请待审批不给 token，也不会自动转为平台新账号", async () => {
  const storage = new Map();
  const requests = [];
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), login: options => options.success({ code: "apply-code" }),
    request(options) { requests.push(options); options.success({ statusCode: 201, data: { status: "pending", fingerprint: "a1b2c3d4e5f6" } }); }
  };
  const entry = pageAt("../pages/entry/index.js");
  entry.setData({ wechatStatus: "unbound" });
  entry.onWechatApplyOpen();
  entry.setData({ applicantName: "主办方", applicantContact: "13800000000", applicantAgreed: true });
  await entry.onApply();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.endsWith("/auth/wechat/apply"), true);
  assert.equal(entry.data.wechatStatus, "pending");
  assert.equal(storage.has(SESSION_KEY), false);
  delete global.wx;
});

test("游客浏览只请求公开活动和案例，不调用账号或相册列表并保持游客详情", async () => {
  const calls = [];
  global.wx = {
    getStorageSync() { throw new Error("游客预览不读取登录态"); },
    navigateTo: value => calls.push(value.url),
    request(options) {
      calls.push(options.url);
      assert.equal(options.header.Authorization, undefined);
      options.success({ statusCode: 200, data: options.url.endsWith("/public/activities")
        ? { activities: [{ id: "act_001", title: "肖像美拍", planLocked: true }] }
        : { cases: [{ id: "case_demo", title: "精彩案例" }] } });
    }
  };
  const workbench = pageAt("../pages/workbench/index.js");
  workbench.onLoad({ guest: "1" });
  await workbench.load();
  assert.equal(workbench.data.guest, true);
  assert.equal(workbench.data.tab, "activities");
  assert.equal(workbench.data.projects.length, 0);
  assert.equal(workbench.data.canCreateProjects, false);
  assert.equal(calls.length, 2);
  workbench.onTab({ currentTarget: { dataset: { tab: "projects" } } });
  workbench.onManage({ currentTarget: { dataset: { id: "project_other" } } });
  workbench.onView({ currentTarget: { dataset: { id: "project_other" } } });
  assert.equal(workbench.data.tab, "activities");
  assert.equal(calls.length, 2);
  workbench.onCatalog({ currentTarget: { dataset: { type: "activities", id: "act_001" } } });
  assert.equal(calls.at(-1), "/pages/catalog/index?type=activities&id=act_001&guest=1");
  delete global.wx;
});

test("游客详情不能利用已有本地 token 下载方案或案例素材", async () => {
  const requests = [];
  const modals = [];
  global.wx = {
    getStorageSync() { throw new Error("游客详情不读取本地登录态"); },
    request(options) {
      requests.push(options);
      assert.equal(options.header.Authorization, undefined);
      options.success({ statusCode: 200, data: { activity: { id: "act_001", title: "活动介绍", planLocked: true } } });
    },
    setNavigationBarTitle() {}, showModal: options => modals.push(options),
    downloadFile() { throw new Error("游客不能下载受限资料"); }
  };
  const catalog = pageAt("../pages/catalog/index.js");
  catalog.guestMode = true;
  catalog.type = "activities";
  catalog.id = "act_001";
  catalog.onShow();
  await catalog.load();
  await catalog.onSopPdf();
  await catalog.onCaseSave({ currentTarget: { dataset: { index: 0 } } });
  await catalog.onCaseDocument({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(requests.length, 1);
  assert.equal(modals.length, 3);
  assert.equal(modals.every(modal => modal.title === "需要登录"), true);
  assert.deepEqual(catalog.data.planSections, []);
  delete global.wx;
});

test("游客再次分享的案例路径仍可匿名浏览，不自动登录或申请", async () => {
  const calls = [];
  global.wx = {
    getStorageSync: () => null,
    login() { throw new Error("案例分享不得获取微信身份"); },
    request(options) {
      calls.push(options);
      options.success({ statusCode: 200, data: { case: { id: "case_demo", title: "案例实录", media: [] } } });
    },
    setNavigationBarTitle() {}
  };
  const catalog = pageAt("../pages/catalog/index.js");
  catalog.type = "cases";
  catalog.id = "case_demo";
  catalog.guestMode = true;
  await catalog.load();
  const payload = catalog.onShareAppMessage();
  assert.equal(payload.path, "/pages/catalog/index?type=cases&id=case_demo");
  const shared = pageAt("../pages/catalog/index.js");
  shared.type = "cases";
  shared.id = "case_demo";
  await shared.load();
  assert.equal(shared.data.loggedIn, false);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.url.endsWith("/public/cases/case_demo") && !call.header.Authorization), true);
  delete global.wx;
});

test("只读账号可以看到全部活动相册，但没有新建和管理入口", async () => {
  const calls = [];
  const storage = new Map([[SESSION_KEY, { token: "test-token", user: { role: "viewer" } }]]);
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), redirectTo: value => calls.push(value.url),
    navigateTo: value => calls.push(value.url),
    request(options) {
      calls.push(options.url);
      const data = options.url.endsWith("/me") ? { user: { role: "viewer", name: "资料账号" } }
        : options.url.endsWith("/my/activity-projects") ? { projects: [{ id: "project_85aae4b746069044", title: "别人的相册", media: [], canManage: false }], canCreate: false }
        : options.url.endsWith("/public/activities") ? { activities: [{ id: "act_001", title: "肖像美拍" }] }
          : { cases: [] };
      options.success({ statusCode: 200, data });
    }
  };
  const workbench = pageAt("../pages/workbench/index.js");
  await workbench.load();
  assert.equal(workbench.data.canCreateProjects, false);
  assert.equal(workbench.data.tab, "projects");
  assert.equal(workbench.data.projects.length, 1);
  assert.equal(workbench.data.projects[0].canManage, false);
  assert.equal(workbench.data.visibleActivities.length, 1);
  assert.equal(calls.some(value => String(value).includes("/my/activity-projects")), true);
  workbench.onCreateOpen();
  assert.equal(workbench.data.creating, false);
  workbench.onManage({ currentTarget: { dataset: { id: "project_85aae4b746069044" } } });
  assert.equal(calls.at(-1), "/pages/manage/index?id=project_85aae4b746069044");
  delete global.wx;
});
