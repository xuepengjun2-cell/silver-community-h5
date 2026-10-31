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
// Yield one bounded chunk at a time, including nested ANMF frame data.
// A file may contain millions of empty unknown chunks; never retain their descriptors.
function* webpChunks(b, start, end) {
  for (let p = start; p < end;) {
    if (p + 8 > end) invalid();
    const size = b.readUInt32LE(p + 4),
      data = p + 8,
      next = data + size + (size % 2);
    if (next > end || (size % 2 && b[data + size] !== 0)) invalid();
    yield { type: b.toString("ascii", p, p + 4), data, size, end: data + size };
    p = next;
  }
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
  let index = 0,
    canvas = null,
    animated = false,
    animation = false,
    frames = 0,
    still = false;
  for (const chunk of chunks) {
    const { type, data, size } = chunk;
    const first = index++ === 0;
    if (type === "VP8X") {
      if (!first || size !== 10) invalid();
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

// One structural scan stops at the image's own EOI. Only the MP Index may
// authorize any additional JPEG ranges; ordinary JPEGs still require EOF.
function jpegImage(b, collectIndex = false) {
    if (b.length < 8 || b.readUInt16BE(0) !== 0xffd8) invalid();
    let p = 2,
      frame = false,
      components = new Set(),
      scan = false,
      end = false,
      mpf = null;
    while (p < b.length) {
      if (b[p++] !== 255) invalid();
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xd9) {
        end = true;
        break;
      }
      if (marker === 0 || marker === 0xd8) invalid();
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > b.length) invalid();
      const n = b.readUInt16BE(p);
      if (n < 2 || p + n > b.length) invalid();
      if (collectIndex && marker === 0xe2 && n >= 6 && b.toString("ascii", p + 2, p + 6) === "MPF\0") {
        if (mpf || scan) invalid();
        mpf = { start: p + 6, end: p + n };
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (n < 8 || !b.readUInt16BE(p + 3) || !b.readUInt16BE(p + 5)) invalid();
        const count=b[p+7];
        if(!count || count>4 || n!==8+3*count)invalid();
        components=new Set();
        for(let i=0;i<count;i++) {
          const at=p+8+3*i, id=b[at], sampling=b[at+1];
          if(components.has(id) || !(sampling>>4) || (sampling>>4)>4 || !(sampling&15) || (sampling&15)>4 || b[at+2]>3)invalid();
          components.add(id);
        }
        frame = true;
      }
      if(marker===0xda) {
        const count=b[p+2], seen=new Set();
        if(!frame || !count || count>components.size || n!==6+2*count)invalid();
        for(let i=0;i<count;i++) {
          const id=b[p+3+2*i], tables=b[p+4+2*i];
          if(!components.has(id) || seen.has(id) || (tables>>4)>3 || (tables&15)>3)invalid();
          seen.add(id);
        }
      }
      p += n;
      if (marker === 0xda) {
        scan = true;
        let payload=0;
        while (p < b.length) {
          if (b[p] !== 255) {
            payload++;p++;
            continue;
          }
          const m = b[p + 1];
          if (m === 0 || (m >= 0xd0 && m <= 0xd7)) {
            if(m===0)payload++;
            p += 2;
            continue;
          }
          break;
        }
        if(!payload)invalid();
      }
    }
    if (!frame || !scan || !end) invalid();
    return { end: p, mpf };
}
function jpegStructure(b) {
  const primary = jpegImage(b, true);
  if (!primary.mpf) {
    if (primary.end !== b.length) invalid();
    return;
  }
  const { start, end } = primary.mpf;
  const tiff = b.subarray(start, end);
  if (tiff.length < 8) invalid();
  const endian = tiff.toString("ascii", 0, 2);
  if (endian !== "II" && endian !== "MM") invalid();
  const u16 = p => endian === "II" ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p);
  const u32 = p => endian === "II" ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p);
  if (u16(2) !== 42) invalid();
  const directory = offset => {
    if (offset < 8 || offset + 2 > tiff.length) invalid();
    const count = u16(offset), end = offset + 2 + count * 12 + 4;
    if (!count || count > 128 || end > tiff.length) invalid();
    return { offset, count, end };
  };
  const index = directory(u32(4));
  let version = false, images = null, table = null;
  for (let n = 0; n < index.count; n++) {
    const entry = index.offset + 2 + n * 12;
    const tag = u16(entry), type = u16(entry + 2), count = u32(entry + 4);
    if (tag === 0xb000) {
      if (version || type !== 7 || count !== 4 || tiff.toString("ascii", entry + 8, entry + 12) !== "0100") invalid();
      version = true;
    } else if (tag === 0xb001) {
      if (images !== null || type !== 4 || count !== 1) invalid();
      images = u32(entry + 8);
    } else if (tag === 0xb002) {
      if (table || type !== 7) invalid();
      table = { offset: u32(entry + 8), bytes: count };
    }
  }
  // APP2 is at most64KiB; cap image scans independently to bound parser work.
  if (!version || !images || images > 32 || !table || table.bytes !== images * 16) invalid();
  const tableEnd = table.offset + table.bytes;
  const overlaps = (a, z, c, d) => a < d && c < z;
  if (table.offset < 8 || tableEnd > tiff.length || overlaps(table.offset, tableEnd, index.offset, index.end)) invalid();
  const next = u32(index.end - 4);
  if (next) {
    // A following MP Attribute IFD is legal, but not a second index chain.
    const attributes = directory(next);
    if (overlaps(next, attributes.end, index.offset, index.end) || overlaps(next, attributes.end, table.offset, tableEnd) || u32(attributes.end - 4)) invalid();
  }
  const ranges = [];
  for (let n = 0; n < images; n++) {
    const entry = table.offset + n * 16;
    const attribute = u32(entry), size = u32(entry + 4), offset = u32(entry + 8);
    if ((attribute & 0x07000000) || size < 8 || u16(entry + 12) > images || u16(entry + 14) > images) invalid();
    const imageStart = n === 0 ? 0 : start + offset;
    if (n === 0 && (offset !== 0 || size !== primary.end)) invalid();
    if (n > 0 && !offset) invalid();
    if (imageStart + size > b.length) invalid();
    ranges.push({ start: imageStart, end: imageStart + size });
  }
  ranges.sort((a, b) => a.start - b.start);
  let previousEnd = primary.end;
  for (const range of ranges.slice(1)) {
    if (range.start < previousEnd) invalid();
    const image = b.subarray(range.start, range.end);
    if (jpegImage(image).end !== image.length) invalid();
    previousEnd = range.end;
  }
  // Gaps explicitly delimited by the index may carry MPF metadata. No tail
  // after the final indexed JPEG is authorized, even if it resembles a JPEG.
  if (previousEnd !== b.length) invalid();
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
    jpegStructure(b);
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
      let bytes=0;
      while (p < b.length) {
        const n = b[p++];
        if (!n) return bytes;
        if (p + n > b.length) invalid();
        p += n;bytes+=n;
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
        if(!(b[10]&128) && !(packed&128))invalid();
        p += 9;
        if (packed & 128) p += 3 * 2 ** ((packed & 7) + 1);
        if (p >= b.length || b[p] < 2 || b[p] > 8) invalid();
        p++;
        if(!blocks())invalid();
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
