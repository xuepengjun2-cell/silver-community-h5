const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_KEY, MANUAL_LOGOUT_KEY, LAST_LOGIN_METHOD_KEY,
  getSession, login, bindWechat, logout, validateSession
} = require("../utils/auth");

const inHours = hours => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
const tick = () => new Promise(resolve => setImmediate(resolve));
const original = (method = "wechat-miniapp", hours = 6) => ({
  token: "old-token", user: { id: "u_original", role: "member" },
  loginMethod: method, sessionExpiresAt: inHours(hours)
});

function fakeWx(session, handler) {
  const storage = new Map(session ? [[SESSION_KEY, session]] : []);
  const calls = [];
  const redirects = [];
  return {
    storage, calls, redirects, loginCalls: 0,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login(options) { this.loginCalls++; options.success({ code: `fresh-code-${this.loginCalls}` }); },
    request(options) { calls.push(options); handler(options, this); },
    redirectTo: options => redirects.push(options.url), navigateTo: options => redirects.push(options.url)
  };
}

function success(options, data) { options.success({ statusCode: 200, data }); }
function me(options, session) {
  success(options, { user: session.user, loginMethod: session.loginMethod, sessionExpiresAt: session.sessionExpiresAt });
}
function pageAt(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
}

test("首次登录记录方法和有效期，真实绑定方法归一为微信且不保存密码", async () => {
  const expiry = inHours(168);
  const wx = fakeWx(null, options => success(options, {
    token: options.url.endsWith("/login") ? "password-token" : "bound-token",
    user: { id: "u_original", role: "member" },
    loginMethod: options.url.endsWith("/login") ? "password" : "wechat-miniapp-bind",
    sessionExpiresAt: expiry
  }));
  await login(wx, "platform", "never-store-this");
  assert.equal(getSession(wx).loginMethod, "password");
  assert.equal(getSession(wx).sessionExpiresAt, expiry);
  await bindWechat(wx, "platform", "never-store-this");
  assert.equal(getSession(wx).loginMethod, "wechat-miniapp");
  assert.equal(wx.storage.get(LAST_LOGIN_METHOD_KEY), "wechat-miniapp");
  assert.equal(JSON.stringify(wx.storage.get(SESSION_KEY)).includes("never-store-this"), false);
});

test("有效密码会话自动进入，entry onLoad/onShow合并同一次服务端核验", async () => {
  const session = original("password", 48);
  let request;
  const wx = fakeWx(session, options => { request = options; });
  global.wx = wx;
  const entry = pageAt("../pages/entry/index.js");
  const load = entry.onLoad({});
  const show = entry.onShow();
  assert.equal(wx.calls.length, 1);
  me(request, session);
  await Promise.all([load, show]);
  assert.deepEqual(wx.redirects, ["/pages/workbench/index"]);
  assert.equal(wx.loginCalls, 0);
  delete global.wx;
});

test("显式登录页返回前台重新核验，网络失败保留token但不进入未核验工作台", async () => {
  const session = original("password", 48);
  let attempt = 0;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/auth/capabilities")) return success(options, { capabilities: { wechatLogin: false } });
    attempt++;
    if (attempt === 1) options.fail({ errMsg: "request:fail offline" });
    else me(options, session);
  });
  global.wx = wx;
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({ mode: "login" });
  assert.equal(getSession(wx).token, "old-token");
  assert.deepEqual(wx.redirects, []);
  await entry.onShow();
  assert.equal(wx.calls.filter(call => call.url.endsWith("/me")).length, 2);
  assert.deepEqual(wx.redirects, ["/pages/workbench/index"]);
  delete global.wx;
});

test("微信会话临近到期只续验一次，带原Bearer且维持同一平台userId", async () => {
  const session = original();
  let renewal;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) me(options, session);
    else renewal = options;
  });
  const first = validateSession(wx);
  const second = validateSession(wx);
  assert.equal(first, second);
  await tick();
  assert.equal(wx.loginCalls, 1);
  assert.equal(renewal.header.Authorization, "Bearer old-token");
  assert.deepEqual(renewal.data, { code: "fresh-code-1", autoRenew: true });
  success(renewal, { token: "renewed-token", user: session.user, loginMethod: "wechat-miniapp", sessionExpiresAt: inHours(168) });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.token, "renewed-token");
  assert.equal(b.user.id, "u_original");
  assert.equal(wx.calls.length, 2);
});

test("密码、未知旧方法、管理员或未临期会话均不自动获取微信身份", async () => {
  for (const session of [original("password"), original("unknown-method"), original("wechat-miniapp", 48),
    { ...original(), user: { id: "u_hq", role: "admin" } },
    { token: "legacy-token", user: { id: "u_original", role: "member" } }]) {
    const wx = fakeWx(session, options => me(options, session));
    await validateSession(wx);
    assert.equal(wx.loginCalls, 0);
    assert.equal(wx.calls.length, 1);
  }
});

test("已过期、服务端撤销或无效身份不会自动恢复，且清除原会话", async () => {
  for (const response of [
    { statusCode: 200, data: { user: original().user, loginMethod: "wechat-miniapp", sessionExpiresAt: inHours(-1) } },
    { statusCode: 401, data: { error: "会话已撤销", code: "SESSION_REVOKED" } },
    { statusCode: 403, data: { error: "权限已变化" } }
  ]) {
    const wx = fakeWx(original(), options => options.success(response));
    await assert.rejects(validateSession(wx));
    assert.equal(getSession(wx), null);
    assert.equal(wx.loginCalls, 0);
  }
  const wx = fakeWx(original(), options => success(options, { user: null }));
  assert.equal(await validateSession(wx), null);
  assert.equal(wx.loginCalls, 0);
});

test("静默续验503时继续有效原会话并短退避，后续仍每次/me核验权限", async () => {
  const session = original();
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) me(options, session);
    else options.success({ statusCode: 503, data: { error: "微信服务暂不可用" } });
  });
  assert.equal((await validateSession(wx)).token, "old-token");
  assert.equal((await validateSession(wx)).token, "old-token");
  assert.equal(wx.loginCalls, 1);
  assert.equal(wx.calls.filter(call => call.url.endsWith("/me")).length, 2);
});

test("主动退出在请求发出前清本地会话，晚到/me不得重新保存或跳转", async () => {
  const session = original();
  let validation;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) validation = options;
    else {
      assert.equal(wx.storage.get(MANUAL_LOGOUT_KEY), true);
      assert.equal(getSession(wx), null);
      success(options, { ok: true });
    }
  });
  global.wx = wx;
  const entry = pageAt("../pages/entry/index.js");
  const restore = entry.onLoad({});
  await logout(wx);
  me(validation, session);
  await restore;
  assert.equal(getSession(wx), null);
  assert.deepEqual(wx.redirects, []);
  assert.equal(wx.loginCalls, 0);
  delete global.wx;
});

test("退出期间晚到的续验新token被精确撤销，不保存也不重新进入工作台", async () => {
  const session = original();
  let renewal;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) me(options, session);
    else if (options.url.endsWith("/auth/wechat/session")) renewal = options;
    else success(options, { ok: true });
  });
  const restore = validateSession(wx);
  await tick();
  await logout(wx);
  success(renewal, { token: "late-renewal-token", user: session.user, loginMethod: "wechat-miniapp", sessionExpiresAt: inHours(168) });
  await assert.rejects(restore, error => error.cancelled === true);
  assert.equal(getSession(wx), null);
  assert.equal(wx.storage.get(MANUAL_LOGOUT_KEY), true);
  assert.deepEqual(wx.calls.filter(call => call.url.endsWith("/logout")).map(call => call.header.Authorization), ["Bearer old-token", "Bearer late-renewal-token"]);
});

test("续验返回另一个userId时拒绝写入并撤销返回token", async () => {
  const session = original();
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) me(options, session);
    else if (options.url.endsWith("/auth/wechat/session")) success(options, {
      token: "wrong-user-token", user: { id: "u_other", role: "member" }, loginMethod: "wechat-miniapp", sessionExpiresAt: inHours(168)
    });
    else success(options, { ok: true });
  });
  await assert.rejects(validateSession(wx), error => error.cancelled === true);
  assert.equal(getSession(wx), null);
  assert.equal(wx.calls.at(-1).header.Authorization, "Bearer wrong-user-token");
});

test("旧显式登录晚到不覆盖新登录账号，也只撤销旧响应的token", async () => {
  let earlier;
  const wx = fakeWx(null, options => {
    if (options.url.endsWith("/login") && options.data.username === "earlier") earlier = options;
    else if (options.url.endsWith("/login")) success(options, { token: "latest-token", user: { id: "u_latest", role: "member" } });
    else success(options, { ok: true });
  });
  const first = login(wx, "earlier", "password");
  await login(wx, "latest", "password");
  success(earlier, { token: "earlier-token", user: { id: "u_earlier", role: "member" } });
  await assert.rejects(first, error => error.cancelled === true);
  assert.equal(getSession(wx).user.id, "u_latest");
  assert.equal(getSession(wx).token, "latest-token");
  assert.equal(wx.calls.at(-1).header.Authorization, "Bearer earlier-token");
});

test("选择游客浏览取消正在恢复的跳转和微信续验，不删除原有效token", async () => {
  const session = original();
  let validation;
  const wx = fakeWx(session, options => { validation = options; });
  global.wx = wx;
  const entry = pageAt("../pages/entry/index.js");
  const restore = entry.onLoad({});
  entry.onGuest();
  me(validation, session);
  await restore;
  await entry.onShow();
  assert.deepEqual(wx.redirects, ["/pages/workbench/index?guest=1"]);
  assert.equal(getSession(wx).token, "old-token");
  assert.equal(wx.loginCalls, 0);
  assert.equal(wx.calls.length, 1);
  delete global.wx;
});

test("游客取消后过早续验返回原token时，不误撤销仍有效的原会话", async () => {
  const session = original();
  let renewal;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) me(options, session);
    else if (options.url.endsWith("/auth/wechat/session")) renewal = options;
    else throw new Error("返回原token的取消结果不得执行logout");
  });
  global.wx = wx;
  const entry = pageAt("../pages/entry/index.js");
  const restore = entry.onLoad({});
  await tick();
  entry.onGuest();
  success(renewal, { token: "old-token", user: session.user, loginMethod: "wechat-miniapp", sessionExpiresAt: inHours(48) });
  await restore;
  assert.equal(getSession(wx).token, "old-token");
  assert.equal(wx.calls.some(call => call.url.endsWith("/logout")), false);
  assert.deepEqual(wx.redirects, ["/pages/workbench/index?guest=1"]);
  delete global.wx;
});

test("旧工作台业务请求晚到403不清除期间新登录的另一个账号", async () => {
  const session = original("password", 48);
  let albumRequest;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) me(options, session);
    else if (options.url.endsWith("/my/activity-projects")) albumRequest = options;
    else if (options.url.endsWith("/login")) success(options, { token: "new-account-token", user: { id: "u_new", role: "member" } });
    else success(options, { activities: [], cases: [] });
  });
  global.wx = wx;
  const workbench = pageAt("../pages/workbench/index.js");
  const loading = workbench.load();
  await tick();
  await login(wx, "new-account", "password");
  albumRequest.success({ statusCode: 403, data: { error: "旧账号权限已变化" } });
  await loading;
  assert.equal(getSession(wx).user.id, "u_new");
  assert.deepEqual(wx.redirects, []);
  delete global.wx;
});

test("工作台验证阶段旧/me晚到401不清新登录，也不覆盖新账号界面", async () => {
  const session = original("password", 48);
  let oldMe;
  const wx = fakeWx(session, options => {
    if (options.url.endsWith("/me")) oldMe = options;
    else if (options.url.endsWith("/login")) success(options, { token: "new-account-token", user: { id: "u_new", role: "member" } });
    else throw new Error("过期的恢复操作不得加载工作台数据");
  });
  global.wx = wx;
  const workbench = pageAt("../pages/workbench/index.js");
  const loading = workbench.load();
  await login(wx, "new-account", "password");
  workbench.setData({ user: { id: "u_new", role: "member" }, error: "" });
  oldMe.success({ statusCode: 401, data: { error: "旧会话已撤销" } });
  await loading;
  assert.equal(getSession(wx).user.id, "u_new");
  assert.equal(workbench.data.user.id, "u_new");
  assert.equal(workbench.data.error, "");
  assert.deepEqual(wx.redirects, []);
  delete global.wx;
});
