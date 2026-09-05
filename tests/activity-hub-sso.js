const assert = require("assert/strict");
const crypto = require("crypto");
const { resolveActivityHubUser, verifyActivityHubSsoToken } = require("../server/activity-hub-sso");

const secret = "activity-hub-sso-test-secret-with-more-than-32-chars";
const now = 1_757_000_000;
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const claims = {
  v: 1,
  iss: "kkhc-channel-assistant-v2",
  aud: "silver-activity",
  sub: "store-user-1",
  u: "store-user",
  n: "测试门店",
  r: "operator",
  iat: now,
  exp: now + 120,
  accessExp: now + 3600,
  jti: "0123456789abcdef0123456789abcdef"
};
const header = encode({ alg: "HS256", typ: "JWT" });
const payload = encode(claims);
const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
const token = `${header}.${payload}.${signature}`;

const verified = verifyActivityHubSsoToken(token, { secret, now });
assert.equal(verified.subject, claims.sub);
assert.equal(verified.username, claims.u);
assert.equal(verified.expiresAt, claims.exp);

const db = { users: [
  { id: "activity-user-1", username: "silver-operator", status: "active" },
  { id: "disabled-user", username: "store-user", status: "disabled" }
] };
assert.equal(resolveActivityHubUser(db, verified, { "store-user": "silver-operator" }).id, "activity-user-1");
assert.equal(resolveActivityHubUser({ users: [{ id: "same", username: "store-user", status: "active" }] }, verified).id, "same");
assert.equal(resolveActivityHubUser({ users: [{ id: "none", username: "other", status: "active" }] }, verified), null);

assert.throws(() => verifyActivityHubSsoToken(`${header}.${payload}.bad`, { secret, now }));
assert.throws(() => verifyActivityHubSsoToken(token, { secret, now: now + 121 }));
assert.throws(() => verifyActivityHubSsoToken(token, { secret: "short", now }));

console.log("activity hub SSO verification, mapping, signature and expiry tests passed");
