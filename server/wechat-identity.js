const crypto = require("crypto");

const WECHAT_CODE_ENDPOINT = "https://api.weixin.qq.com/sns/jscode2session";

function identityError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validateApplication(input = {}) {
  const name = String(input.name || "").trim();
  const contact = String(input.contact || "").trim();
  const city = String(input.city || "").trim();
  const organization = String(input.organization || "").trim();
  if (name.length < 2 || name.length > 60) throw identityError("请填写真实姓名（2 至 60 字）");
  if (contact.length < 6 || contact.length > 80) throw identityError("请填写便于总部核实的联系方式");
  if (city.length > 80 || organization.length > 120) throw identityError("城市或机构名称过长");
  return { name, contact, city, organization };
}

function identityFingerprint(appid, openid) {
  return crypto.createHash("sha256").update(`${appid}:${openid}`).digest("hex").slice(0, 12);
}

async function exchangeWechatCode(code, { appid, secret, fetchImpl = globalThis.fetch } = {}) {
  if (!appid || !secret) throw identityError("微信登录尚未配置，请暂用原账号登录", 503);
  if (!code || String(code).length > 512 || /\s/.test(String(code))) throw identityError("微信登录凭证无效，请重试");
  if (typeof fetchImpl !== "function") throw identityError("微信登录服务暂不可用", 503);
  const url = new URL(WECHAT_CODE_ENDPOINT);
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw identityError("微信身份核验暂不可用，请稍后重试", 502);
  }
  if (!response.ok) throw identityError("微信身份核验暂不可用，请稍后重试", 502);
  let result;
  try { result = await response.json(); }
  catch { throw identityError("微信身份核验返回异常，请稍后重试", 502); }
  if (!result || typeof result !== "object") throw identityError("微信身份核验返回异常，请稍后重试", 502);
  if (Number(result.errcode) === 45011) throw identityError("微信登录过于频繁，请稍后重试", 429);
  if (Number(result.errcode) === -1) throw identityError("微信登录服务暂不可用，请稍后重试", 502);
  if (result.errcode || typeof result.openid !== "string" || !result.openid
    || result.openid.length > 128 || /[\s\x00-\x1f]/.test(result.openid)) {
    throw identityError("微信登录凭证已失效，请重试", 401);
  }
  // session_key/secret 绝不返回给小程序，也不写入日志或业务用户档案。
  return { appid, openid: result.openid };
}

module.exports = { exchangeWechatCode, identityError, identityFingerprint, validateApplication };
