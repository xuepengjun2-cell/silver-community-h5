const crypto = require("crypto");

const MAX_TICKET_SECONDS = 120;
const MAX_CLOCK_SKEW_SECONDS = 30;

function decodeJson(segment) {
  return JSON.parse(Buffer.from(String(segment || ""), "base64url").toString("utf8"));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ssoError(message, statusCode = 401) {
  return Object.assign(new Error(message), { statusCode });
}

function verifyActivityHubSsoToken(token, { secret, now = Math.floor(Date.now() / 1000) } = {}) {
  const signingSecret = String(secret || "").trim();
  if (signingSecret.length < 32) throw ssoError("活动案例免密入口尚未配置", 503);

  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw ssoError("免密入口票据格式不正确");
  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw ssoError("免密入口票据无法解析");
  }

  const expected = crypto.createHmac("sha256", signingSecret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  if (!safeEqual(parts[2], expected)) throw ssoError("免密入口票据签名无效");
  if (header.alg !== "HS256" || header.typ !== "JWT") throw ssoError("免密入口票据算法不支持");
  if (claims.v !== 1 || claims.iss !== "kkhc-channel-assistant-v2" || claims.aud !== "silver-activity") {
    throw ssoError("免密入口票据来源不正确");
  }

  const subject = String(claims.sub || "");
  const username = String(claims.u || "").trim().toLowerCase();
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const accessExpiresAt = Number(claims.accessExp);
  const jti = String(claims.jti || "");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(subject)
    || !/^[a-z0-9_.-]{3,40}$/.test(username)
    || !/^[a-f0-9]{32,128}$/i.test(jti)
    || !Number.isInteger(issuedAt)
    || !Number.isInteger(expiresAt)
    || !Number.isInteger(accessExpiresAt)) {
    throw ssoError("免密入口票据身份信息不完整");
  }
  if (issuedAt > now + MAX_CLOCK_SKEW_SECONDS
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_TICKET_SECONDS
    || accessExpiresAt < expiresAt
    || accessExpiresAt <= now) {
    throw ssoError("免密入口票据已过期或无效");
  }

  return {
    version: claims.v,
    subject,
    username,
    displayName: String(claims.n || username).slice(0, 60),
    role: String(claims.r || "operator").slice(0, 32),
    issuedAt,
    expiresAt,
    accessExpiresAt,
    jti
  };
}

function resolveActivityHubUser(db, claims, userMap = {}) {
  const users = Array.isArray(db?.users) ? db.users : [];
  const mapped = userMap && typeof userMap === "object"
    ? userMap[claims.username]
    : "";
  const mappedUsername = typeof mapped === "string"
    ? mapped
    : (mapped && typeof mapped === "object" ? mapped.username : "");
  const mappedName = String(mappedUsername || "").trim().toLowerCase();
  return users.find(user => user
    && user.status === "active"
    && (String(user.ssoSubject || "") === claims.subject
      || String(user.ssoUsername || "").trim().toLowerCase() === claims.username
      || (mappedName && String(user.username || "").trim().toLowerCase() === mappedName))) || null;
}

function resolveOrProvisionActivityHubUser(db, claims, userMap = {}) {
  const existing = resolveActivityHubUser(db, claims, userMap);
  if (existing) return { user: existing, created: false };
  const users = Array.isArray(db?.users) ? db.users : [];
  const mapped = userMap && typeof userMap === "object" ? userMap[claims.username] : "";
  const mappedUsername = typeof mapped === "string" ? mapped : (mapped && typeof mapped === "object" ? mapped.username : "");
  const conflictingUsernames = new Set([claims.username, String(mappedUsername || "").trim().toLowerCase()].filter(Boolean));
  const identityCollision = users.find(user => user && (String(user.ssoSubject || "") === claims.subject
    || conflictingUsernames.has(String(user.username || "").trim().toLowerCase())
    || conflictingUsernames.has(String(user.ssoUsername || "").trim().toLowerCase())));
  if (identityCollision) return { user: null, created: false, blocked: true };

  const id = `sso_${crypto.createHash("sha256").update(`${claims.subject}:${claims.username}`).digest("hex").slice(0, 24)}`;
  if (users.some(user => String(user?.id || "") === id)) return { user: null, created: false, blocked: true };
  const user = {
    id,
    username: claims.username,
    name: claims.displayName || claims.username,
    role: "member",
    status: "active",
    canDownload: true,
    ssoSubject: claims.subject,
    ssoUsername: claims.username,
    authSource: "kkhc-channel-assistant-v2",
    createdAt: new Date().toISOString()
  };
  users.push(user);
  return { user, created: true };
}

module.exports = { MAX_TICKET_SECONDS, resolveActivityHubUser, resolveOrProvisionActivityHubUser, verifyActivityHubSsoToken };
