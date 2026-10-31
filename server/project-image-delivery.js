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
// Walk only bounded RIFF chunks; ANMF frame data is another padded chunk list.
function webpChunks(b, start, end) {
  const chunks = [];
  for (let p = start; p < end;) {
    if (p + 8 > end) invalid();
    const size = b.readUInt32LE(p + 4),
      data = p + 8,
      next = data + size + (size % 2);
    if (next > end || (size % 2 && b[data + size] !== 0)) invalid();
    chunks.push({ type: b.toString("ascii", p, p + 4), data, size, end: data + size });
    p = next;
  }
  return chunks;
}
function webpBitstream(b, chunk) {
  const { type, data, size } = chunk;
  if (type === "VP8 ") {
    if (size <= 10 || b[data] & 1 || !b.subarray(data + 3, data + 6).equals(Buffer.from("9d012a", "hex"))) invalid();
    const width = b.readUInt16LE(data + 6) & 0x3fff,
      height = b.readUInt16LE(data + 8) & 0x3fff;
    if (!width || !height) invalid();
    return { width, height };
  }
  if (type === "VP8L") {
    if (size <= 5 || b[data] !== 0x2f) invalid();
    const bits = b.readUInt32LE(data + 1);
    if (bits >>> 29) invalid();
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  invalid();
}
function webpStructure(b) {
  if (
    b.length < 20 ||
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WEBP" ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    invalid();
  const chunks = webpChunks(b, 12, b.length);
  let canvas = null,
    animated = false,
    animation = false,
    frames = 0,
    still = false;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i],
      { type, data, size } = chunk;
    if (type === "VP8X") {
      if (i !== 0 || size !== 10) invalid();
      canvas = { width: b.readUIntLE(data + 4, 3) + 1, height: b.readUIntLE(data + 7, 3) + 1 };
      if (canvas.width * canvas.height > 0xffffffff) invalid();
      animated = Boolean(b[data] & 2);
    } else if (type === "ANIM") {
      if (!animated || !canvas || animation || frames || size !== 6) invalid();
      animation = true;
    } else if (type === "ANMF") {
      if (!canvas || !animated || !animation || still || size < 16) invalid();
      const x = b.readUIntLE(data, 3) * 2,
        y = b.readUIntLE(data + 3, 3) * 2,
        width = b.readUIntLE(data + 6, 3) + 1,
        height = b.readUIntLE(data + 9, 3) + 1;
      if (x + width > canvas.width || y + height > canvas.height) invalid();
      let bitstream = null,
        alpha = false;
      for (const nested of webpChunks(b, data + 16, chunk.end)) {
        if (nested.type === "ALPH") {
          if (alpha || bitstream || nested.size < 2) invalid();
          alpha = true;
        } else if (["VP8 ", "VP8L"].includes(nested.type)) {
          if (bitstream || (alpha && nested.type === "VP8L")) invalid();
          bitstream = webpBitstream(b, nested);
        } else if (["ANMF", "ANIM", "VP8X"].includes(nested.type)) invalid();
      }
      if (!bitstream || bitstream.width !== width || bitstream.height !== height) invalid();
      frames++;
    } else if (["VP8 ", "VP8L"].includes(type)) {
      if (animated || still || frames) invalid();
      const dimensions = webpBitstream(b, chunk);
      if (canvas && (dimensions.width !== canvas.width || dimensions.height !== canvas.height)) invalid();
      still = true;
    }
  }
  if (animated ? !animation || !frames || still : !still) invalid();
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
    webpStructure(b);
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
