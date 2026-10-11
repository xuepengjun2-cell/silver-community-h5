"use strict";

// Client metadata is never evidence that an uploaded video passed processing.
const MAX_DELIVERY_BYTES = 190 * 1024 * 1024;
const PROTECTED_FIELDS = ["size", "poster", "fingerprint", "sourceSha256", "sourceVideoId", "createdAt"];

function trustedObjectKey(value, locations) {
  if (typeof value !== "string") return "";
  for (const [base, prefix] of locations) {
    if (!value.startsWith(`${base}/`)) continue;
    const name = value.slice(base.length + 1);
    if (!/^[A-Za-z0-9_.%~-]+$/.test(name)) continue;
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { continue; }
    if (!/^[A-Za-z0-9_.~-]+$/.test(decoded) || decoded === "." || decoded === "..") continue;
    if (`${base}/${encodeURIComponent(decoded)}` !== value) continue;
    return `${prefix}/${decoded}`;
  }
  return "";
}

function assertDeliveryMetadata(media) {
  if (!Number.isSafeInteger(media.size) || media.size <= 0 || media.size >= MAX_DELIVERY_BYTES ||
      !/^[a-f0-9]{64}$/.test(media.fingerprint || "") || !media.poster || !/\.mp4$/.test(media.url || "")) {
    throw new Error("视频尚未通过成片校验：须小于200MB、有封面并由后台处理完成，请重新上传。");
  }
}

function canonicalVideoReferences(media, { existing = [], ready = [], requireAll = false } = {}) {
  const checks = [];
  const result = media.map(item => {
    if (item.type !== "video") {
      if (/\.(?:mp4|m4v|mov|webm)(?:[?#]|$)/i.test(item.url || "") && !existing.some(asset => asset.type === item.type && asset.url === item.url)) throw new Error("视频文件必须通过视频上传处理，不能作为图片或外部链接直接登记。");
      return item;
    }
    const old = existing.find(asset => asset.type === "video" && asset.url === item.url);
    const asset = old || ready.find(asset => asset.type === "video" && asset.url === item.url);
    if (!asset) throw new Error("不能直接登记视频链接，请上传视频并等待后台处理完成。");
    const canonical = { ...item };
    for (const key of PROTECTED_FIELDS) {
      delete canonical[key];
      if (asset[key] !== undefined) canonical[key] = asset[key];
    }
    if (!old || requireAll) {
      assertDeliveryMetadata(canonical);
      checks.push(canonical);
    }
    return canonical;
  });
  return { media: result, checks };
}

module.exports = { MAX_DELIVERY_BYTES, trustedObjectKey, assertDeliveryMetadata, canonicalVideoReferences };
