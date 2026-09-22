const config = require("../config");
const PROJECT_ID = /^project_[a-f0-9]{16}$/;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

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
  if (!media || !["image", "video"].includes(media.type)) return "";
  const prefix = media.type === "video" ? config.videoBase : config.imageBase;
  const url = String(media.url || "");
  return url.startsWith(prefix) && url.length > prefix.length && !/[\s#]/.test(url) ? url : "";
}

function isMp4(media) {
  return /\.mp4(?:\?|$)/i.test(String(media && media.url || ""));
}

function saveSource(media) {
  if (media && media.type === "video" && media.delivery && media.delivery.url) {
    const candidate = { type: "video", url: media.delivery.url, size: media.delivery.size };
    if (trustedMediaUrl(candidate) && isMp4(candidate) && Number(candidate.size) > 0) return candidate;
  }
  return media;
}

function saveEligibility(media) {
  if (!trustedMediaUrl(media)) return { ok: false, reason: "这个素材尚未接入相册保存服务，请联系活动主办方。" };
  if (media.type === "image") {
    if (!/\.(?:jpe?g|png)(?:\?|$)/i.test(media.url)) return { ok: false, reason: "这张照片还不是可保存的 JPG 或 PNG，请联系活动主办方转换后再试。" };
    return { ok: true, reason: "" };
  }
  const source = saveSource(media);
  if (!isMp4(source)) return { ok: false, reason: "原视频不是 MP4，请主办方上传可保存的 MP4 版本。" };
  if (!Number.isFinite(Number(source.size)) || Number(source.size) <= 0) return { ok: false, reason: "视频大小尚未确认，请联系活动主办方补全交付文件。" };
  if (Number(source.size) > MAX_VIDEO_BYTES) return { ok: false, reason: "视频超过 200 MB，请主办方上传压缩后的 MP4 版本。" };
  return { ok: true, reason: "" };
}

function displayName(media, index) {
  return String(media && media.title || "").trim() || `${media && media.type === "video" ? "视频" : "照片"} ${index + 1}`;
}

module.exports = {
  MAX_VIDEO_BYTES, parseShareInput, parseAlbumOptions, albumPath, mediaPath,
  trustedMediaUrl, isMp4, saveSource, saveEligibility, displayName
};
