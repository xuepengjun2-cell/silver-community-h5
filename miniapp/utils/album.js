const config = require("../config");
const PROJECT_ID = /^project_[a-f0-9]{16}$/;

function parseShareInput(input) {
  const value = String(input || "").trim();
  const direct = value.match(/^(project_[a-f0-9]{16})(?:\.(\d+))?$/i);
  const fromUrl = value.match(/[?&#](?:share|project|id)=(project_[a-f0-9]{16})(?:\.(\d+))?(?=[&#]|$)/i);
  const match = direct || fromUrl;
  if (!match) return null;
  const index = match[2] === undefined ? null : Number(match[2]);
  return Number.isSafeInteger(index) && index >= 0 || index === null
    ? { id: match[1].toLowerCase(), index }
    : null;
}

function parseAlbumOptions(options) {
  const id = String(options && options.id || "");
  if (!PROJECT_ID.test(id)) return null;
  const raw = options && options.i;
  const index = raw === undefined || raw === "" ? null : Number(raw);
  if (index !== null && (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(index))) return null;
  return { id, index };
}

function albumPath(id, index = null) {
  if (!PROJECT_ID.test(id)) throw new Error("相册编号无效");
  const suffix = Number.isSafeInteger(index) && index >= 0 ? `&i=${index}` : "";
  return `/pages/album/index?id=${id}${suffix}`;
}

function mediaPath(id, index) {
  if (!PROJECT_ID.test(id) || !Number.isSafeInteger(index) || index < 0) throw new Error("素材编号无效");
  return `/pages/media/index?id=${id}&i=${index}`;
}

function trustedMediaUrl(media) {
  if (!media || media.type !== "image") return "";
  const url = String(media.url || "");
  if (!url.startsWith(config.imageBase) || /[\s#\\]/.test(url)) return "";
  const path = url.slice(config.imageBase.length).split("?")[0];
  // 保留后台支持的图片预览格式，不接受目录跳转或编码后的路径分隔符。
  if (!path || !/\.(?:jpe?g|png|webp|gif|svg)$/i.test(path) || /%(?:2e|2f|5c|3f|23)/i.test(path) ||
      /\.(?:mp4|m4v|mov|webm|avi|mkv|flv|m3u8|ts)(?:[./]|$)/i.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..")) return "";
  return url;
}

function saveSource(media) {
  return media && media.type === "image" ? media : null;
}

function saveEligibility(media) {
  if (!media || media.type !== "image") return { ok: false, reason: "这个素材在本小程序中不可用，请返回照片相册。" };
  if (!trustedMediaUrl(media)) {
    return { ok: false, reason: "这张照片尚未接入 JPG 或 PNG 图片保存服务，请联系活动主办方。" };
  }
  if (!/\.(?:jpe?g|png)(?:\?|$)/i.test(media.url)) {
    return { ok: false, reason: "这张图片可预览，请主办方转换为 JPG 或 PNG 后再保存。" };
  }
  return { ok: true, reason: "" };
}

function displayName(media, index) {
  return String(media && media.title || "").trim() || `照片 ${index + 1}`;
}

module.exports = {
  parseShareInput, parseAlbumOptions, albumPath, mediaPath,
  trustedMediaUrl, saveSource, saveEligibility, displayName
};
