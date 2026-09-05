const crypto = require("crypto");

const CLOCK_SKEW_SECONDS = 30;
const MAX_TICKET_LIFETIME_SECONDS = 10 * 60;

function decodeJsonSegment(segment) {
  try {
    return JSON.parse(Buffer.from(String(segment || ""), "base64url").toString("utf8"));
  } catch {
    throw new Error("免密凭证格式不正确");
  }
}

function verifyActivityHubSsoToken(token, { secret, now = Math.floor(Date.now() / 1000) } = {}) {
  const signingSecret = String(secret || "").trim();
  if (signingSecret.length < 32) throw new Error("活动案例免密登录尚未配置");
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error("免密凭证格式不正确");
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  const input = encodedHeader + "." + encodedPayload;
  const expected = crypto.createHmac("sha256", signingSecret).update(input).digest();
  let actual;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("免密凭证签名不正确");
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("免密凭证签名不正确");
  }
  const header = decodeJsonSegment(encodedHeader);
  const claims = decodeJsonSegment(encodedPayload);
  if (header.alg !== "HS256" || header.typ !== "JWT"
    || claims.v !== 1
    || claims.iss !== "kkhc-channel-assistant-v2"
    || claims.aud !== "silver-activity") {
    throw new Error("免密凭证来源不受信任");
  }
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const accessExpiresAt = Number(claims.accessExp);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(claims.sub || ""))
    || !/^[a-z0-9_.-]{3,40}$/.test(String(claims.u || ""))
    || !/^[A-Za-z0-9_-]{8,128}$/.test(String(claims.jti || ""))
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > now + CLOCK_SKEW_SECONDS
    || expiresAt <= now - CLOCK_SKEW_SECONDS
    || expiresAt > now + MAX_TICKET_LIFETIME_SECONDS
    || (Number.isFinite(accessExpiresAt) && accessExpiresAt <= now)) {
    throw new Error("免密凭证已过期或身份信息不完整");
  }
  return {
    ...claims,
    username: String(claims.u).toLowerCase(),
    expiresAt,
    accessExpiresAt: Number.isFinite(accessExpiresAt) ? accessExpiresAt : 0
  };
}

function resolveActivityHubUser(db, claims, userMap = {}) {
  const aliases = Object.fromEntries(Object.entries(userMap || {}).map(([key, value]) => [
    String(key).trim().toLowerCase(),
    String(typeof value === "object" ? value.username : value).trim().toLowerCase()
  ]).filter(([, value]) => value));
  const username = String(claims.username || claims.u || "").trim().toLowerCase();
  const mappedUsername = aliases[username] || username;
  return (db.users || []).find(user => user.status === "active" && (
    String(user.ssoSubject || "") === String(claims.sub)
    || String(user.ssoUsername || "").trim().toLowerCase() === username
    || String(user.username || "").trim().toLowerCase() === mappedUsername
  )) || null;
}

function consumeActivityHubTicket(file, jti, expiresAt, { readJson, writeJson, now = Date.now } = {}) {
  if (typeof readJson !== "function" || typeof writeJson !== "function") throw new Error("免密凭证存储未配置");
  const current = readJson(file, {});
  const nowMs = Number(now());
  const retained = Object.fromEntries(Object.entries(current || {}).filter(([, record]) => Number(record?.expiresAt || 0) > nowMs));
  if (retained[jti]) return false;
  retained[jti] = { usedAt: new Date(nowMs).toISOString(), expiresAt: Number(expiresAt) * 1000 };
  const entries = Object.entries(retained).slice(-5000);
  writeJson(file, Object.fromEntries(entries));
  return true;
}

module.exports = {
  verifyActivityHubSsoToken,
  resolveActivityHubUser,
  consumeActivityHubTicket
};
