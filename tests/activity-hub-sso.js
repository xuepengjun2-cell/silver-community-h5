const assert = require("assert");
const crypto = require("crypto");
const {
  verifyActivityHubSsoToken,
  resolveActivityHubUser,
  consumeActivityHubTicket
} = require("../server/activity-hub-sso");

const now = 1800000000;
const secret = "fixture-secret-at-least-thirty-two-characters";
const claims = {
  v: 1,
  iss: "kkhc-channel-assistant-v2",
  aud: "silver-activity",
  sub: "store-fixture",
  u: "fixture-user",
  n: "测试门店",
  r: "operator",
  iat: now,
  exp: now + 120,
  accessExp: now + 300,
  jti: "fixture-ticket-12345678"
};
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const input = encode({ alg: "HS256", typ: "JWT" }) + "." + encode(claims);
const token = input + "." + crypto.createHmac("sha256", secret).update(input).digest("base64url");

assert.equal(verifyActivityHubSsoToken(token, { secret, now }).username, "fixture-user");
assert.equal(resolveActivityHubUser({
  users: [
    { id: "u1", username: "other", status: "active" },
    { id: "u2", username: "silver-user", status: "active", ssoUsername: "fixture-user" }
  ]
}, claims).id, "u2");
assert.equal(resolveActivityHubUser({
  users: [{ id: "u3", username: "mapped-user", status: "active" }]
}, claims, { "fixture-user": "mapped-user" }).id, "u3");

const store = {};
const readJson = (file, fallback) => Object.prototype.hasOwnProperty.call(store, file) ? store[file] : fallback;
const writeJson = (file, value) => { store[file] = value; };
assert.equal(consumeActivityHubTicket("tickets", claims.jti, claims.exp, { readJson, writeJson, now: () => now * 1000 }), true);
assert.equal(consumeActivityHubTicket("tickets", claims.jti, claims.exp, { readJson, writeJson, now: () => now * 1000 }), false);

const badSignature = input + ".bad-signature";
assert.throws(() => verifyActivityHubSsoToken(badSignature, { secret, now }));
assert.throws(() => verifyActivityHubSsoToken(token, { secret: "short", now }));
assert.throws(() => verifyActivityHubSsoToken(token, { secret, now: now + 1000 }));
console.log("activity hub SSO verification, mapping and one-time ticket tests passed");
