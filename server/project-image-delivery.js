"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
function invalid() {
  throw new Error("照片格式或完整性校验失败，原文件保留。");
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let c = value;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function structure(b, ext) {
  if (ext === "png") {
    if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) invalid();
    let p = 8,
      first = true,
      data = false,
      end = false;
    while (p + 12 <= b.length) {
      const n = b.readUInt32BE(p),
        type = b.toString("ascii", p + 4, p + 8);
      if (n > b.length - p - 12) invalid();
      if (crc32(b.subarray(p + 4, p + 8 + n)) !== b.readUInt32BE(p + 8 + n)) invalid();
      if (first && (type !== "IHDR" || n !== 13 || !b.readUInt32BE(p + 8) || !b.readUInt32BE(p + 12))) invalid();
      first = false;
      if (type === "IDAT" && n) data = true;
      p += 12 + n;
      if (type === "IEND") {
        if (n || p !== b.length) invalid();
        end = true;
        break;
      }
    }
    if (!data || !end) invalid();
  } else if (ext === "jpg" || ext === "jpeg") {
    if (b.length < 8 || b.readUInt16BE(0) !== 0xffd8) invalid();
    let p = 2,
      frame = false,
      scan = false,
      end = false;
    while (p < b.length) {
      if (b[p++] !== 255) invalid();
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xd9) {
        end = p === b.length;
        break;
      }
      if (marker === 0 || marker === 0xd8) invalid();
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > b.length) invalid();
      const n = b.readUInt16BE(p);
      if (n < 2 || p + n > b.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (n < 8 || !b.readUInt16BE(p + 3) || !b.readUInt16BE(p + 5)) invalid();
        frame = true;
      }
      p += n;
      if (marker === 0xda) {
        scan = true;
        while (p < b.length) {
          if (b[p] !== 255) {
            p++;
            continue;
          }
          const m = b[p + 1];
          if (m === 0 || (m >= 0xd0 && m <= 0xd7)) {
            p += 2;
            continue;
          }
          break;
        }
      }
    }
    if (!frame || !scan || !end) invalid();
  } else if (ext === "gif") {
    if (
      b.length < 14 ||
      !["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)) ||
      !b.readUInt16LE(6) ||
      !b.readUInt16LE(8)
    )
      invalid();
    let p = 13 + (b[10] & 128 ? 3 * 2 ** ((b[10] & 7) + 1) : 0),
      image = false,
      end = false;
    const blocks = () => {
      while (p < b.length) {
        const n = b[p++];
        if (!n) return;
        if (p + n > b.length) invalid();
        p += n;
      }
      invalid();
    };
    while (p < b.length) {
      const tag = b[p++];
      if (tag === 0x3b) {
        end = p === b.length;
        break;
      }
      if (tag === 0x21) {
        p++;
        blocks();
      } else if (tag === 0x2c) {
        if (p + 9 > b.length || !b.readUInt16LE(p + 4) || !b.readUInt16LE(p + 6)) invalid();
        const packed = b[p + 8];
        p += 9;
        if (packed & 128) p += 3 * 2 ** ((packed & 7) + 1);
        if (p >= b.length || b[p] < 2 || b[p] > 8) invalid();
        p++;
        blocks();
        image = true;
      } else invalid();
    }
    if (!image || !end) invalid();
  } else if (ext === "webp") {
    if (
      b.length < 20 ||
      b.toString("ascii", 0, 4) !== "RIFF" ||
      b.toString("ascii", 8, 12) !== "WEBP" ||
      b.readUInt32LE(4) + 8 !== b.length
    )
      invalid();
    let p = 12,
      image = false;
    while (p + 8 <= b.length) {
      const type = b.toString("ascii", p, p + 4),
        n = b.readUInt32LE(p + 4);
      if (!n || p + 8 + n > b.length) invalid();
      if (type === "VP8 ") {
        if (n < 10 || !b.subarray(p + 11, p + 14).equals(Buffer.from("9d012a", "hex"))) invalid();
        image = true;
      }
      if (type === "VP8L") {
        if (n < 5 || b[p + 8] !== 0x2f) invalid();
        image = true;
      }
      if (type === "ANMF") {
        if (n < 24) invalid();
        image = true;
      }
      p += 8 + n + (n % 2);
    }
    if (!image || p !== b.length) invalid();
  } else invalid();
}
async function validateProjectImage(file, { ext, expectedSize, signal } = {}) {
  signal?.throwIfAborted();
  ext = String(ext || "")
    .replace(/^\./, "")
    .toLowerCase();
  const before = await fs.promises.stat(file);
  if (
    !before.isFile() ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > MAX_IMAGE_BYTES ||
    before.size !== expectedSize
  )
    invalid();
  const hash = crypto.createHash("sha256"),
    chunks = [];
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { signal })) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > expectedSize) invalid();
    hash.update(chunk);
    chunks.push(chunk);
  }
  signal?.throwIfAborted();
  const after = await fs.promises.stat(file);
  if (
    size !== expectedSize ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    after.size !== size
  )
    invalid();
  structure(Buffer.concat(chunks, size), ext);
  return {
    size,
    fingerprint: hash.digest("hex"),
    contentType: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`,
  };
}
module.exports = { validateProjectImage, MAX_IMAGE_BYTES };
