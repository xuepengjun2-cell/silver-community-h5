const config = require("../config");

const SESSION_KEY = "silver_miniapp_session_v1";
const ALLOWED_ROLES = ["admin", "operator", "member", "viewer"];

function canManageProjects(user) { return Boolean(user && ["admin", "operator", "member"].includes(user.role)); }

function getSession(wxApi) {
  const value = wxApi.getStorageSync(SESSION_KEY);
  return value && typeof value.token === "string" && value.user ? value : null;
}

function clearSession(wxApi) { wxApi.removeStorageSync(SESSION_KEY); }

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
  if (!response.token || !response.user || !ALLOWED_ROLES.includes(response.user.role)) {
    throw new Error("此账号没有小程序访问权限，请联系管理员。");
  }
  const session = { token: response.token, user: response.user };
  wxApi.setStorageSync(SESSION_KEY, session);
  return session;
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
  } finally { clearSession(wxApi); }
}

module.exports = { SESSION_KEY, api, login, logout, getSession, clearSession, validateSession, canManageProjects };
