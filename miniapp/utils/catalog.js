const { mediaUrl } = require("./urls");

const CATALOG_TYPES = ["activities", "cases"];
const CATALOG_ID = /^[a-z0-9_-]{1,100}$/i;

function catalogPath(type, id) {
  if (!CATALOG_TYPES.includes(type) || !CATALOG_ID.test(String(id || ""))) throw new Error("内容编号无效");
  return `/pages/catalog/index?type=${type}&id=${encodeURIComponent(id)}`;
}

function shareImage(url) {
  const trusted = mediaUrl(url);
  return /\.(?:jpe?g|png)(?:\?|$)/i.test(trusted) ? trusted : "";
}

function catalogCover(item, type) {
  const imageMedia = type === "cases"
    ? (item.media || []).filter(entry => entry.type === "image").map(entry => entry.url)
    : item.images || [];
  const candidates = [item.cover, ...imageMedia].filter(Boolean);
  return mediaUrl(candidates.find(shareImage) || candidates[0] || "");
}

function cardView(item, type) {
  const media = Array.isArray(item.media) ? item.media : [];
  const count = type === "cases" ? media.length : (item.images || []).length + (item.videos || []).length;
  const cover = catalogCover(item, type);
  return {
    id: item.id,
    title: item.title || "未命名内容",
    city: item.city || "",
    category: item.category || "",
    intro: item.intro || item.description || "",
    price: item.price || "",
    dateLabel: item.dateLabel || "",
    count,
    cover,
    shareCover: shareImage(cover)
  };
}

function sharePayload(item, type) {
  return {
    title: `${item.title || "活动内容"}｜${type === "cases" ? "精彩案例" : "活动 SOP"}`,
    path: catalogPath(type, item.id),
    ...(shareImage(catalogCover(item, type)) ? { imageUrl: shareImage(catalogCover(item, type)) } : {})
  };
}

module.exports = { catalogPath, cardView, catalogCover, shareImage, sharePayload };
