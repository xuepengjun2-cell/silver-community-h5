const test = require("node:test");
const assert = require("node:assert/strict");
const { login, logout, getSession, validateSession, SESSION_KEY } = require("../utils/auth");
const { prepareMedia, MAX_VIDEO } = require("../utils/upload");

function fakeWx(response) {
  const storage = new Map();
  const calls = [];
  return {
    storage, calls,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request(options) { calls.push(options); options.success(response(options)); }
  };
}

test("主办方复用 H5 账号但客户端仅存 token，退出后服务端撤销 Bearer", async () => {
  const wx = fakeWx(options => options.url.endsWith("/login")
    ? { statusCode: 200, data: { user: { role: "operator", name: "主办方" }, token: "token-test" } }
    : options.url.endsWith("/me")
      ? { statusCode: 200, data: { user: { role: "operator", name: "主办方" } } }
      : { statusCode: 200, data: { ok: true } });
  await login(wx, "user", "secret");
  assert.equal(getSession(wx).token, "token-test");
  assert.equal(wx.storage.get(SESSION_KEY).password, undefined);
  assert.equal((await validateSession(wx)).user.role, "operator");
  await logout(wx);
  assert.equal(wx.calls.at(-1).header.Authorization, "Bearer token-test");
  assert.equal(getSession(wx), null);
});

test("不让只读账号获得相册管理入口", async () => {
  const wx = fakeWx(() => ({ statusCode: 200, data: { user: { role: "viewer" }, token: "x" } }));
  await assert.rejects(() => login(wx, "user", "password"), /没有活动相册管理权限/);
  assert.equal(getSession(wx), null);
});

test("视频压缩后超出交付边界时不调用上传", async () => {
  const wx = {
    compressVideo: options => options.success({ tempFilePath: "/temporary/compressed.mp4" }),
    getFileInfo: options => options.success({ size: MAX_VIDEO })
  };
  await assert.rejects(() => prepareMedia(wx, "/temporary/source.mov", "video"), /分段上传/);
});
