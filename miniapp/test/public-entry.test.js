const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SESSION_KEY, getSession } = require("../utils/auth");
const { PUBLIC_HOME, WORKBENCH, catalogReturnTo, loginPath } = require("../utils/navigation");

function pageAt(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
}

function fakeWx(handler, session) {
  const storage = new Map(session ? [[SESSION_KEY, session]] : []);
  const requests = [];
  const navigations = [];
  return {
    storage, requests, navigations,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login() { throw new Error("未开通或未主动选择时不得获取微信身份"); },
    request(options) { requests.push(options); handler(options); },
    redirectTo: options => navigations.push(options.url), navigateTo: options => navigations.push(options.url),
    setNavigationBarTitle() {}
  };
}

function ok(options, data) { options.success({ statusCode: 200, data }); }

test("无会话启动只进公开内容，不探测微信能力或索取微信身份", async () => {
  global.wx = fakeWx(() => { throw new Error("首次公开启动不调用身份接口"); });
  const entry = pageAt("../pages/entry/index.js");
  await Promise.all([entry.onLoad({}), entry.onShow()]);
  assert.deepEqual(wx.navigations, [PUBLIC_HOME]);
  assert.equal(entry.data.loginPage, false);
  assert.equal(wx.requests.length, 0);
  delete global.wx;
});

test("过期或离线会话默认降到公开浏览，离线时保留token且不进入鉴权工作台", async () => {
  for (const offline of [false, true]) {
    const session = { token: "old-token", user: { id: "u_existing", role: "member" }, loginMethod: "password" };
    global.wx = fakeWx(options => {
      if (offline) options.fail({ errMsg: "request:fail offline" });
      else options.success({ statusCode: 401, data: { error: "登录过期" } });
    }, session);
    const entry = pageAt("../pages/entry/index.js");
    await entry.onLoad({});
    assert.deepEqual(wx.navigations, [PUBLIC_HOME]);
    assert.equal(Boolean(getSession(wx)), offline);
    assert.equal(wx.requests.every(request => request.url.endsWith("/me")), true);
    delete global.wx;
  }
});

test("显式登录页面以平台密码为主且申请表收起；微信能力未知、false、503均关闭", async () => {
  for (const readiness of [undefined, false, "true", "unavailable"]) {
    global.wx = fakeWx(options => readiness === "unavailable"
      ? options.success({ statusCode: 503, data: { error: "暂不可用" } })
      : ok(options, { capabilities: { wechatLogin: readiness } }));
    const entry = pageAt("../pages/entry/index.js");
    assert.equal(entry.data.wechatLoginAvailable, false);
    await entry.onLoad({ mode: "login" });
    await entry.capabilitiesPromise;
    assert.equal(entry.data.loginPage, true);
    assert.equal(entry.data.showApply, false);
    assert.equal(entry.data.wechatLoginAvailable, false);
    await entry.onWechatRetry();
    entry.setData({ wechatStatus: "unbound" });
    entry.onBindOpen(); entry.onWechatApplyOpen();
    assert.equal(entry.data.authMode, "password");
    assert.equal(entry.data.showApply, false);
    assert.equal(wx.requests.length, 1);
    assert.deepEqual(wx.navigations, []);
    delete global.wx;
  }
  const wxml = fs.readFileSync(path.join(__dirname, "../pages/entry/index.wxml"), "utf8");
  assert.match(wxml, /wx:if="\{\{wechatLoginAvailable\}\}" class="entry-wechat-section"/);
  assert.ok(wxml.indexOf('bindtap="onSubmit"') < wxml.indexOf('bindtap="onWechatRetry"'));
});

test("微信能力请求挂起不阻塞平台密码登录和独立平台申请", async () => {
  global.wx = fakeWx(options => {
    if (options.url.endsWith("/auth/capabilities")) return;
    if (options.url.endsWith("/login")) return ok(options, { token: "platform-token", user: { id: "u_existing", role: "member" } });
    if (options.url.endsWith("/register")) return ok(options, { ok: true, status: "pending" });
    throw new Error(`unexpected request: ${options.url}`);
  });
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({ mode: "login" });
  assert.equal(entry.data.loading, false);
  entry.onPlatformApplyOpen();
  entry.setData({ applicantUsername: "new-host", applicantPassword: "host-secret", applicantName: "主办方", applicantContact: "人工核实联系方式", applicantAgreed: true });
  await entry.onApply();
  assert.equal(getSession(wx), null);
  assert.match(entry.data.applicationMessage, /总部核实并开通/);
  entry.setData({ username: "existing", password: "platform-secret" });
  await entry.onSubmit();
  assert.deepEqual(wx.navigations, [WORKBENCH]);
  assert.equal(getSession(wx).user.id, "u_existing");
  assert.equal(entry.data.wechatLoginAvailable, false);
  delete global.wx;
});

test("回跳白名单只接受活动和案例详情，去除guest参数并拒绝其他页面与注入", () => {
  for (const type of ["activities", "cases"]) {
    const target = `/pages/catalog/index?type=${type}&id=item_001`;
    assert.equal(catalogReturnTo(target), target);
    assert.equal(catalogReturnTo(encodeURIComponent(`${target}&guest=1`)), target);
    assert.equal(loginPath(`${target}&guest=1`), `/pages/entry/index?mode=login&returnTo=${encodeURIComponent(target)}`);
  }
  for (const value of ["https://example.com", "//example.com", "/pages/manage/index?id=project_85aae4b746069044",
    "/pages/workbench/index", "/pages/catalog/index?type=cases&id=case_001&admin=1",
    "/pages/catalog/index?type=cases&id=case_001#fragment", "/pages/catalog/index?type=unknown&id=case_001",
    "/pages/catalog/index?type=cases&id=../other", "/pages/catalog/index?type=cases&id=a&id=b", "%E0%A4%A"]) {
    assert.equal(catalogReturnTo(value), "", value);
    assert.equal(loginPath(value), "/pages/entry/index?mode=login");
  }
});

test("活动与案例游客登录后返回同一详情，移除guest并重新请求有权限的内容", async () => {
  for (const type of ["activities", "cases"]) {
    const target = `/pages/catalog/index?type=${type}&id=item_001`;
    global.wx = fakeWx(options => {
      if (options.url.endsWith("/auth/capabilities")) return ok(options, { capabilities: { wechatLogin: false } });
      if (options.url.endsWith("/login")) return ok(options, { token: "platform-token", user: { id: "u_existing", role: "member", canDownload: true } });
      assert.equal(options.header.Authorization, "Bearer platform-token");
      ok(options, type === "activities"
        ? { activity: { id: "item_001", title: "完整方案", plan: { target: "定位内容" } } }
        : { case: { id: "item_001", title: "案例", media: [] } });
    });
    const guest = pageAt("../pages/catalog/index.js");
    guest.type = type; guest.id = "item_001"; guest.guestMode = true;
    guest.onLogin();
    assert.equal(wx.navigations.at(-1), loginPath(target));
    const entry = pageAt("../pages/entry/index.js");
    await entry.onLoad({ mode: "login", returnTo: encodeURIComponent(`${target}&guest=1`) });
    entry.setData({ username: "existing", password: "platform-secret" });
    await entry.onSubmit();
    assert.equal(wx.navigations.at(-1), target);
    const reloaded = pageAt("../pages/catalog/index.js");
    reloaded.onLoad({ type, id: "item_001" });
    await reloaded.load();
    assert.equal(reloaded.guestMode, false);
    assert.equal(reloaded.data.loggedIn, true);
    if (type === "activities") assert.equal(reloaded.data.planSections.length, 1);
    delete global.wx;
  }
});

test("已有有效会话的受限操作回跳无需重输密码，未知回跳回到正常工作台", async () => {
  const session = { token: "valid", user: { id: "u_existing", role: "member" }, loginMethod: "password" };
  for (const returnTo of ["/pages/catalog/index?type=cases&id=case_001&guest=1", "/pages/manage/index?id=other"]) {
    global.wx = fakeWx(options => ok(options, options.url.endsWith("/me") ? { user: session.user } : { capabilities: { wechatLogin: false } }), session);
    const entry = pageAt("../pages/entry/index.js");
    await entry.onLoad({ mode: "login", returnTo });
    assert.equal(wx.navigations.at(-1), catalogReturnTo(returnTo) || WORKBENCH);
    assert.equal(wx.requests.some(request => request.url.endsWith("/login")), false);
    delete global.wx;
  }
});

test("旧login入口转发保留安全回跳，通用分享落公开内容且不暴露内部相册", () => {
  const target = "/pages/catalog/index?type=activities&id=act_001&guest=1";
  global.wx = fakeWx(() => {});
  const legacy = pageAt("../pages/login/index.js");
  legacy.onLoad({ returnTo: encodeURIComponent(target) });
  assert.equal(wx.navigations.at(-1), loginPath(target));
  const workbench = pageAt("../pages/workbench/index.js");
  assert.equal(workbench.onShareAppMessage({}).path, PUBLIC_HOME);
  workbench.onLogin();
  assert.equal(wx.navigations.at(-1), "/pages/entry/index?mode=login");
  delete global.wx;
});
