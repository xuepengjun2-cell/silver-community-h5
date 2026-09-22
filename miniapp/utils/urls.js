const config = require("../config");

function mediaUrl(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("/assets/")) return `https://proj2.likeduoduiyi.cn/silver${raw}`;
  if (raw.startsWith("/uploads/")) return `${config.apiBase}${raw}`;
  if (/^https:\/\//i.test(raw) && !/[\s#]/.test(raw)) return raw;
  return "";
}

module.exports = { mediaUrl };
