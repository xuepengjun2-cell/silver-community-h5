const test = require("node:test");
const assert = require("node:assert/strict");
const { SESSION_KEY, MANUAL_LOGOUT_KEY, applyWechat, bindWechat, logout, wechatSession } = require("../utils/auth");

function fakeWx(responses) {
  const storage = new Map();
  const calls = [];
  let nextCode = 0;
  return {
    storage, calls,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login(options) { options.success({ code: `code-${++nextCode}` }); },
    request(options) {
      calls.push(options);
      const path = new URL(options.url).pathname;
      const response = responses[path] || { statusCode: 200, data: { ok: true } };
      options.success(response);
    }
  };
}

test("微信申请待审不发平台 token，批准后复用现有会话结构", async () => {
  const wx = fakeWx({
    "/silver-api/auth/wechat/session": { statusCode: 200, data: { status: "unbound" } },
    "/silver-api/auth/wechat/apply": { statusCode: 201, data: { status: "pending" } },
    "/silver-api/auth/wechat/bind": { statusCode: 200, data: { token: "bound-token", user: { id: "u_old", role: "operator" } } }
  });
  assert.equal((await wechatSession(wx)).status, "unbound");
  assert.equal(wx.storage.has(SESSION_KEY), false);
  assert.equal((await applyWechat(wx, { name: "张三", contact: "13800000000" })).status, "pending");
  assert.equal(wx.storage.has(SESSION_KEY), false);
  assert.equal((await bindWechat(wx, "old-account", "old-password")).user.id, "u_old");
  assert.equal(wx.storage.get(SESSION_KEY).token, "bound-token");
  assert.deepEqual(wx.calls.map(call => call.data.code), ["code-1", "code-2", "code-3"], "每次请求使用新的单次 code");
});

test("主动退出后不立即自动登录，用户可显式重新选择微信登录", async () => {
  const wx = fakeWx({
    "/silver-api/auth/wechat/session": { statusCode: 200, data: { token: "new-token", user: { role: "viewer" } } },
    "/silver-api/logout": { statusCode: 200, data: { ok: true } }
  });
  wx.storage.set(SESSION_KEY, { token: "old-token", user: { role: "viewer" } });
  await logout(wx);
  assert.equal(wx.storage.get(MANUAL_LOGOUT_KEY), true);
  assert.equal((await wechatSession(wx)).status, "signed_out");
  assert.equal(wx.calls.filter(call => call.url.endsWith("/auth/wechat/session")).length, 0);
  assert.equal((await wechatSession(wx, { explicit: true })).session.token, "new-token");
  assert.equal(wx.storage.has(MANUAL_LOGOUT_KEY), false);
});
