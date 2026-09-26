const config = require("../config");

const SESSION_KEY = "silver_miniapp_session_v1";
const MANUAL_LOGOUT_KEY = "silver_miniapp_manual_logout_v1";
const ALLOWED_ROLES = ["admin", "operator", "member", "viewer"];

function canManageProjects(user) { return Boolean(user && ["admin", "operator", "member"].includes(user.role)); }

function getSession(wxApi) {
  const value = wxApi.getStorageSync(SESSION_KEY);
  return value && typeof value.token === "string" && value.user ? value : null;
}

function clearSession(wxApi) { wxApi.removeStorageSync(SESSION_KEY); }

function storeSession(wxApi, response) {
  if (!response.token || !response.user || !ALLOWED_ROLES.includes(response.user.role)) {
    throw new Error("此账号没有小程序访问权限，请联系管理员。");
  }
  const session = { token: response.token, user: response.user };
  wxApi.setStorageSync(SESSION_KEY, session);
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
        reject(error);
      },
      fail() { reject(new Error("网络连接失败，请检查网络后重试。")); }
    });
  });
}

async function login(wxApi, username, password) {
  const response = await api(wxApi, "/login", { method: "POST", data: { username, password } });
  return storeSession(wxApi, response);
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
  const code = await wechatCode(wxApi);
  const result = await api(wxApi, "/auth/wechat/session", { method: "POST", data: { code } });
  if (result.token) return { status: "approved", session: storeSession(wxApi, result) };
  return { status: result.status || "unbound" };
}

async function applyWechat(wxApi, details) {
  const code = await wechatCode(wxApi);
  return api(wxApi, "/auth/wechat/apply", { method: "POST", data: { code, ...details } });
}

async function bindWechat(wxApi, username, password) {
  const code = await wechatCode(wxApi);
  const result = await api(wxApi, "/auth/wechat/bind", { method: "POST", data: { code, username, password } });
  return storeSession(wxApi, result);
}

async function validateSession(wxApi) {
  const session = getSession(wxApi);
  if (!session) return null;
  try {
    const { user } = await api(wxApi, "/me", { token: session.token });
    if (!user || !ALLOWED_ROLES.includes(user.role)) {
      clearSession(wxApi);
      return null;
    }
    const refreshed = { ...session, user };
    wxApi.setStorageSync(SESSION_KEY, refreshed);
    return refreshed;
  } catch (error) {
    if (error.statusCode === 401) clearSession(wxApi);
    throw error;
  }
}

async function logout(wxApi) {
  const session = getSession(wxApi);
  try {
    if (session) await api(wxApi, "/logout", { method: "POST", token: session.token });
  } finally { clearSession(wxApi); wxApi.setStorageSync(MANUAL_LOGOUT_KEY, true); }
}

module.exports = {
  SESSION_KEY, MANUAL_LOGOUT_KEY, api, login, logout, getSession, clearSession, validateSession,
  wechatSession, applyWechat, bindWechat, canManageProjects
};
