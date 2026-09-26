const test = require("node:test");
const assert = require("node:assert/strict");
const { exchangeWechatCode, identityFingerprint, validateApplication } = require("../server/wechat-identity");

test("code2Session 仅返回服务端身份，不返回 session_key 和 AppSecret", async () => {
  let called;
  const identity = await exchangeWechatCode("one-time-code", {
    appid: "wx-test", secret: "server-secret",
    fetchImpl: async url => {
      called = url;
      return { ok: true, json: async () => ({ openid: "openid-A", session_key: "must-not-leak" }) };
    }
  });
  assert.equal(called.hostname, "api.weixin.qq.com");
  assert.equal(called.searchParams.get("js_code"), "one-time-code");
  assert.deepEqual(identity, { appid: "wx-test", openid: "openid-A" });
  assert.equal(JSON.stringify(identity).includes("server-secret"), false);
  assert.equal(JSON.stringify(identity).includes("must-not-leak"), false);
});

test("无服务端密钥、失效 code 与申请缺项均拒绝", async () => {
  await assert.rejects(() => exchangeWechatCode("code", { appid: "wx-test" }), error => error.statusCode === 503);
  await assert.rejects(() => exchangeWechatCode("code", { appid: "wx-test", secret: "secret",
    fetchImpl: async () => ({ ok: true, json: async () => ({ errcode: 40029 }) })
  }), error => error.statusCode === 401);
  assert.throws(() => validateApplication({ name: "甲", contact: "123" }), /真实姓名/);
  assert.deepEqual(validateApplication({ name: " 甲乙 ", contact: " 13800000000 ", city: " 上海 " }), {
    name: "甲乙", contact: "13800000000", city: "上海", organization: ""
  });
  assert.notEqual(identityFingerprint("wx-a", "same"), identityFingerprint("wx-b", "same"));
});
