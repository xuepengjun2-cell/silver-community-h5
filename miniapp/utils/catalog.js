const { mediaUrl } = require("./urls");

const CATALOG_TYPES = ["activities", "cases"];
const CATALOG_ID = /^[a-z0-9_-]{1,100}$/i;

function fileExtension(value) {
  const trusted = mediaUrl(value);
  const match = trusted.match(/^https:\/\/[^/?#]+([^?#]*)(?:\?[^#]*)?$/i);
  if (!match) return "";
  let pathname;
  try { pathname = decodeURIComponent(match[1]); }
  catch (_) { return ""; }
  // 文件类型依据路径校验，查询参数不能把不支持的素材伪装成图片或文档。
  if (/[\\\s#?%]/.test(pathname) || /\.(?:mp4|m4v|mov|webm|avi|mkv|flv|m3u8|ts)(?:[./]|$)/i.test(pathname)) return "";
  return (pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
}

function photoUrl(value) {
  return /^(?:jpe?g|png|webp|gif|svg)$/i.test(fileExtension(value)) ? mediaUrl(value) : "";
}

function documentUrl(value) {
  return /^(?:pdf|docx?|pptx?|xlsx?)$/i.test(fileExtension(value)) ? mediaUrl(value) : "";
}

function caseMedia(item) {
  return (Array.isArray(item.media) ? item.media : []).map((entry, index) => {
    if (!entry || !["image", "document"].includes(entry.type)) return null;
    const url = entry.type === "image" ? photoUrl(entry.url) : documentUrl(entry.url);
    if (!url) return null;
    return {
      index, type: entry.type, url,
      title: entry.title || entry.caption || `${entry.type === "image" ? "照片" : "文档"} ${index + 1}`
    };
  }).filter(Boolean);
}

function activityMedia(item) {
  return (Array.isArray(item.images) ? item.images : []).map((value, index) => ({
    type: "image", url: photoUrl(value), title: `活动照片 ${index + 1}`, index
  })).filter(entry => entry.url);
}

function catalogItemView(item, type) {
  const view = {};
  // 仅把图文详情需要的字段交给页面，不把其他服务的素材地址带入页面数据。
  for (const key of ["id", "title", "city", "category", "intro", "description", "price", "capacity", "duration", "location", "dateLabel", "contact"]) {
    if (typeof item[key] === "string" || typeof item[key] === "number") view[key] = item[key];
  }
  view.cover = catalogCover(item, type);
  if (type === "cases") view.media = caseMedia(item);
  else {
    view.images = activityMedia(item).map(entry => entry.url);
    view.highlights = (Array.isArray(item.highlights) ? item.highlights : []).filter(value => typeof value === "string");
    view.schedule = (Array.isArray(item.schedule) ? item.schedule : []).filter(value => value && typeof value === "object")
      .map(value => ({ time: String(value.time || ""), item: String(value.item || "") }));
    view.planLocked = Boolean(item.planLocked);
    view.downloadEnabled = item.downloadEnabled !== false;
    view.plan = {};
    for (const key of ["target", "materials", "staffing", "conversion", "risk"]) {
      if (item.plan && typeof item.plan[key] === "string") view.plan[key] = item.plan[key];
    }
  }
  return view;
}

function catalogPath(type, id) {
  if (!CATALOG_TYPES.includes(type) || !CATALOG_ID.test(String(id || ""))) throw new Error("内容编号无效");
  return `/pages/catalog/index?type=${type}&id=${encodeURIComponent(id)}`;
}

function shareImage(url) {
  return /^(?:jpe?g|png)$/i.test(fileExtension(url)) ? photoUrl(url) : "";
}

function catalogCover(item, type) {
  const imageMedia = type === "cases"
    ? (Array.isArray(item.media) ? item.media : []).filter(entry => entry && entry.type === "image").map(entry => entry.url)
    : Array.isArray(item.images) ? item.images : [];
  const candidates = [item.cover, ...imageMedia].map(photoUrl).filter(Boolean);
  return candidates.find(shareImage) || candidates[0] || "";
}

function cardView(item, type) {
  const count = (type === "cases" ? caseMedia(item) : activityMedia(item)).length;
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
    shareCover: shareImage(cover),
    searchText: [item.title, item.category, item.city, item.region, item.activityType,
      item.intro, item.description, ...(Array.isArray(item.tags) ? item.tags : [])]
      .filter(Boolean).join(" ").toLocaleLowerCase()
  };
}

function filterCatalogCards(cards, query) {
  const words = String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return cards;
  return cards.filter(card => words.every(word => String(card.searchText || "").includes(word)));
}

function sharePayload(item, type) {
  return {
    title: `${item.title || "活动内容"}｜${type === "cases" ? "精彩案例" : "活动 SOP"}`,
    path: catalogPath(type, item.id),
    ...(shareImage(catalogCover(item, type)) ? { imageUrl: shareImage(catalogCover(item, type)) } : {})
  };
}

module.exports = {
  catalogPath, cardView, catalogCover, shareImage, sharePayload, filterCatalogCards,
  fileExtension, photoUrl, documentUrl, caseMedia, activityMedia, catalogItemView
};
