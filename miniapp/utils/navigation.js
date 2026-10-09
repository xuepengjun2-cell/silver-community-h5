const { catalogPath } = require("./catalog");

const PUBLIC_HOME = "/pages/workbench/index?guest=1";
const WORKBENCH = "/pages/workbench/index";

// 只允许返回公开活动/案例详情；不能将外部地址或管理页作为登录回跳目标。
function catalogReturnTo(value) {
  if (typeof value !== "string" || value.length > 600) return "";
  let path = value;
  try { if (path.includes("%")) path = decodeURIComponent(path); }
  catch (_) { return ""; }
  const match = path.match(/^\/pages\/catalog\/index\?type=(activities|cases)&id=([a-z0-9_-]{1,100})(?:&guest=1)?$/);
  return match ? catalogPath(match[1], match[2]) : "";
}

function loginPath(returnTo) {
  const target = catalogReturnTo(returnTo);
  return `/pages/entry/index?mode=login${target ? `&returnTo=${encodeURIComponent(target)}` : ""}`;
}

module.exports = { PUBLIC_HOME, WORKBENCH, catalogReturnTo, loginPath };
