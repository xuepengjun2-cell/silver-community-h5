const config = require("../config");

const SESSION_KEY = "silver_miniapp_session_v1";
const MANUAL_LOGOUT_KEY = "silver_miniapp_manual_logout_v1";
const LAST_LOGIN_METHOD_KEY = "silver_miniapp_login_method_v1";
const ALLOWED_ROLES = ["admin", "operator", "member", "viewer"];
const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const RENEW_RETRY_MS = 60 * 1000;
const runtimes = new WeakMap();

function runtime(wxApi) {
  if (!runtimes.has(wxApi)) runtimes.set(wxApi, { epoch: 0, validating: null, retryToken: "", retryAfter: 0 });
  return runtimes.get(wxApi);
}

function loginMethod(value) {
  if (value === "wechat-miniapp-bind") return "wechat-miniapp";
  return ["password", "wechat-miniapp", "activity-hub-sso"].includes(value) ? value : "password";
}

function sessionExpiresAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";
}

function getLastLoginMethod(wxApi) {
  const value = wxApi.getStorageSync(LAST_LOGIN_METHOD_KEY);
  return ["password", "wechat-miniapp", "activity-hub-sso"].includes(value) ? value : "";
}

function canManageProjects(user) { return Boolean(user && ["admin", "operator", "member"].includes(user.role)); }

function getSession(wxApi) {
  const value = wxApi.getStorageSync(SESSION_KEY);
  return value && typeof value.token === "string" && value.user ? {
    token: value.token, user: value.user,
    loginMethod: loginMethod(value.loginMethod), sessionExpiresAt: sessionExpiresAt(value.sessionExpiresAt)
  } : null;
}

function clearSession(wxApi) {
  const state = runtime(wxApi);
  state.epoch++;
  state.validating = null;
  state.retryToken = "";
  state.retryAfter = 0;
  wxApi.removeStorageSync(SESSION_KEY);
}

function cancelSessionValidation(wxApi) {
  const state = runtime(wxApi);
  if (!state.validating) return;
  state.epoch++;
  state.validating = null;
}

function isSessionCurrent(wxApi, session) {
  if (!session || wxApi.getStorageSync(MANUAL_LOGOUT_KEY)) return false;
  const current = getSession(wxApi);
  return Boolean(current && current.token === session.token && current.user.id === session.user.id);
}

function operationCurrent(wxApi, epoch) {
  return runtime(wxApi).epoch === epoch && !wxApi.getStorageSync(MANUAL_LOGOUT_KEY);
}

function cancelledLogin() {
  const error = new Error("登录操作已取消，请重新选择登录方式。");
  error.cancelled = true;
  return error;
}

function beginExplicitLogin(wxApi) {
  const state = runtime(wxApi);
  state.epoch++;
  state.validating = null;
  wxApi.removeStorageSync(MANUAL_LOGOUT_KEY);
  return state.epoch;
}

async function discardIssuedToken(wxApi, token) {
  if (!token) return;
  try { await api(wxApi, "/logout", { method: "POST", token }); }
  catch (_) { /* 精确撤销晚到的新会话失败时仍不保存它，后端按有效期回收。 */ }
}

async function storeSession(wxApi, response, epoch, method = "password", expectedUserId = null, originalToken = "") {
  if (!operationCurrent(wxApi, epoch)) {
    if (response.token !== originalToken) await discardIssuedToken(wxApi, response.token);
    throw cancelledLogin();
  }
  if (expectedUserId && (!response.user || response.user.id !== expectedUserId)) {
    clearSession(wxApi);
    await discardIssuedToken(wxApi, response.token);
    throw new Error("微信身份与原平台账号不一致，请重新登录并联系总部核实。");
  }
  if (!response.token || !response.user || !ALLOWED_ROLES.includes(response.user.role)) {
    throw new Error("此账号没有小程序访问权限，请联系管理员。");
  }
  const session = {
    token: response.token, user: response.user,
    loginMethod: loginMethod(response.loginMethod || method), sessionExpiresAt: sessionExpiresAt(response.sessionExpiresAt)
  };
  wxApi.setStorageSync(SESSION_KEY, session);
  wxApi.setStorageSync(LAST_LOGIN_METHOD_KEY, session.loginMethod);
  wxApi.removeStorageSync(MANUAL_LOGOUT_KEY);
  return session;
}

function api(wxApi, path, { method = "GET", data, token } = {}) {
  return new Promise((resolve, reject) => {
    wxApi.request({
      url: `${config.apiBase}${path}`,
      method,
      data,
      header: {
        Accept: "application/json",
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      success(response) {
        const result = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(result);
        const error = new Error(result.error || (response.statusCode === 401 ? "登录已过期，请重新登录。" : "操作失败，请稍后重试。"));
        error.statusCode = response.statusCode;
        error.code = result.code || "";
        reject(error);
      },
      fail() { reject(new Error("网络连接失败，请检查网络后重试。")); }
    });
  });
}

async function login(wxApi, username, password) {
  const epoch = beginExplicitLogin(wxApi);
  const response = await api(wxApi, "/login", { method: "POST", data: { username, password } });
  return storeSession(wxApi, response, epoch, "password");
}

// 平台申请只创建待审记录；即便服务器响应带有其他字段，也不建立登录态。
async function applyPlatform(wxApi, details) {
  return api(wxApi, "/register", { method: "POST", data: details });
}

function wechatCode(wxApi) {
  return new Promise((resolve, reject) => {
    if (typeof wxApi.login !== "function") return reject(new Error("当前环境暂不支持微信登录，请使用原账号。"));
    wxApi.login({
      success(result) {
        if (result.code) resolve(result.code);
        else reject(new Error("未取得微信登录凭证，请重试。"));
      },
      fail() { reject(new Error("微信登录暂不可用，请稍后重试。")); }
    });
  });
}

async function wechatSession(wxApi, { explicit = false } = {}) {
  if (!explicit && wxApi.getStorageSync(MANUAL_LOGOUT_KEY)) return { status: "signed_out" };
  const epoch = explicit ? beginExplicitLogin(wxApi) : runtime(wxApi).epoch;
  const code = await wechatCode(wxApi);
  if (!operationCurrent(wxApi, epoch)) throw cancelledLogin();
  const result = await api(wxApi, "/auth/wechat/session", { method: "POST", data: { code } });
  if (result.token) return { status: "approved", session: await storeSession(wxApi, result, epoch, "wechat-miniapp") };
  if (!operationCurrent(wxApi, epoch)) throw cancelledLogin();
  return { status: result.status || "unbound", fingerprint: result.fingerprint || "" };
}

async function applyWechat(wxApi, details) {
  const code = await wechatCode(wxApi);
  return api(wxApi, "/auth/wechat/apply", { method: "POST", data: { code, ...details } });
}

async function bindWechat(wxApi, username, password) {
  const epoch = beginExplicitLogin(wxApi);
  const code = await wechatCode(wxApi);
  if (!operationCurrent(wxApi, epoch)) throw cancelledLogin();
  const result = await api(wxApi, "/auth/wechat/bind", { method: "POST", data: { code, username, password } });
  return storeSession(wxApi, result, epoch, "wechat-miniapp");
}

async function checkSession(wxApi, session, epoch) {
  const result = await api(wxApi, "/me", { token: session.token });
  if (!operationCurrent(wxApi, epoch) || !isSessionCurrent(wxApi, session)) throw cancelledLogin();
  if (!result.user || !ALLOWED_ROLES.includes(result.user.role) || session.user.id && result.user.id !== session.user.id) {
    clearSession(wxApi);
    return null;
  }
  const refreshed = {
    token: session.token, user: result.user,
    loginMethod: loginMethod(result.loginMethod === undefined ? session.loginMethod : result.loginMethod),
    sessionExpiresAt: sessionExpiresAt(result.sessionExpiresAt === undefined ? session.sessionExpiresAt : result.sessionExpiresAt)
  };
  const remaining = Date.parse(refreshed.sessionExpiresAt) - Date.now();
  if (Number.isFinite(remaining) && remaining <= 0) {
    const error = new Error("登录已过期，请重新登录。");
    error.statusCode = 401;
    throw error;
  }
  wxApi.setStorageSync(SESSION_KEY, refreshed);
  wxApi.setStorageSync(LAST_LOGIN_METHOD_KEY, refreshed.loginMethod);
  const state = runtime(wxApi);
  if (refreshed.loginMethod !== "wechat-miniapp" || refreshed.user.role === "admin" || !refreshed.user.id
    || !(remaining > 0 && remaining <= RENEW_WINDOW_MS)
    || state.retryToken === refreshed.token && state.retryAfter > Date.now()) return refreshed;
  try {
    const code = await wechatCode(wxApi);
    if (!operationCurrent(wxApi, epoch) || !isSessionCurrent(wxApi, refreshed)) throw cancelledLogin();
    const renewal = await api(wxApi, "/auth/wechat/session", {
      method: "POST", token: refreshed.token, data: { code, autoRenew: true }
    });
    if (!renewal.token) {
      const error = new Error("微信绑定或账号权限已变化，请重新登录。");
      error.statusCode = 403;
      throw error;
    }
    return await storeSession(wxApi, renewal, epoch, "wechat-miniapp", refreshed.user.id, refreshed.token);
  } catch (error) {
    if (error.cancelled) throw error;
    if (error.statusCode === 401 || error.statusCode === 403) throw error;
    // 网络或微信服务暂不可用时保留已复核的有效会话，短时间内不反复续验。
    if (!operationCurrent(wxApi, epoch) || !isSessionCurrent(wxApi, refreshed)) throw cancelledLogin();
    if (Date.parse(refreshed.sessionExpiresAt) <= Date.now()) {
      const expired = new Error("登录已过期，请重新登录。");
      expired.statusCode = 401;
      throw expired;
    }
    state.retryToken = refreshed.token;
    state.retryAfter = Date.now() + RENEW_RETRY_MS;
    return refreshed;
  }
}

function validateSession(wxApi) {
  const session = getSession(wxApi);
  if (!session || wxApi.getStorageSync(MANUAL_LOGOUT_KEY)) return Promise.resolve(null);
  const state = runtime(wxApi);
  if (state.validating) return state.validating;
  const epoch = state.epoch;
  const pending = checkSession(wxApi, session, epoch).catch(error => {
    if (!operationCurrent(wxApi, epoch)) throw cancelledLogin();
    if ((error.statusCode === 401 || error.statusCode === 403) && operationCurrent(wxApi, epoch)) clearSession(wxApi);
    throw error;
  }).finally(() => { if (state.validating === pending) state.validating = null; });
  state.validating = pending;
  return pending;
}

async function logout(wxApi) {
  const session = getSession(wxApi);
  wxApi.setStorageSync(MANUAL_LOGOUT_KEY, true);
  clearSession(wxApi);
  if (session) await api(wxApi, "/logout", { method: "POST", token: session.token });
}

module.exports = {
  SESSION_KEY, MANUAL_LOGOUT_KEY, LAST_LOGIN_METHOD_KEY, api, login, logout, getSession, clearSession, validateSession, cancelSessionValidation, isSessionCurrent, getLastLoginMethod,
  wechatSession, applyWechat, applyPlatform, bindWechat, canManageProjects
};
