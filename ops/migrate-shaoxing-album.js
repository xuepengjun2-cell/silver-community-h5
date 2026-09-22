#!/usr/bin/env node
"use strict";

// One-off, resumable Shaoxing album migration. Never replaces or deletes source TOS objects.
// Run on the Silver host from an explicitly deployed release with --workdir and --run.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const mysql = require("mysql2/promise");
const { processVideo, processVideoPoster } = require("../server/miniapp-media");

const ID = "project_85aae4b746069044";
const API = "http://127.0.0.1:5174/api";
const VIDEO_BASE = "https://proj2.likeduoduiyi.cn/silver-project-videos";
const IMAGE_BASE = "https://proj2.likeduoduiyi.cn/silver-project-images";
const MAX_OUTPUT = 190 * 1024 * 1024;
const args = process.argv.slice(2);
const workArg = args.find(s => s.startsWith("--workdir="));
const workdir = workArg && path.resolve(workArg.slice(10));
const run = args.includes("--run");
const onlyArg = args.find(s => s.startsWith("--only-index="));
const onlyIndex = onlyArg ? Number(onlyArg.slice(13)) : null;
const limitArg = args.find(s => s.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice(8)) : Infinity;
if (!workdir || !/^\/var\/tmp\/silver-shaoxing-[a-zA-Z0-9-]+$/.test(workdir)) throw new Error("Dedicated --workdir=/var/tmp/silver-shaoxing-... required");
if (onlyIndex !== null && (!Number.isInteger(onlyIndex) || onlyIndex < 1 || onlyIndex > 36)) throw new Error("Invalid --only-index");
if (!(limit > 0 && (Number.isInteger(limit) || limit === Infinity))) throw new Error("Invalid --limit");
process.umask(0o077);
fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
const manifestFile = path.join(workdir, "manifest.json");
const backupFile = path.join(workdir, "album-backup.json");
const journalFile = path.join(workdir, "journal.jsonl");
let baselinePid = 0;
let stopRequested = false;
process.on("SIGTERM", () => { stopRequested = true; });
process.on("SIGINT", () => { stopRequested = true; });

function saveOnce(file, value) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
function append(entry) {
  fs.appendFileSync(journalFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}
function journal() {
  return fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}
function pm2Pid() { return Number(execFileSync("pm2", ["pid", "silver"], { encoding: "utf8" }).trim()); }
function serviceEnv() {
  const raw = fs.readFileSync(`/proc/${baselinePid}/environ`, "utf8");
  return Object.fromEntries(raw.split("\0").filter(Boolean).map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
}
function fileEnv(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).filter(s => s.trim() && !s.trim().startsWith("#") && s.includes("="))
      .map(s => { const i = s.indexOf("="); return [s.slice(0, i).trim(), s.slice(i + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, (_m, a, b) => a || b || "")]; }));
  } catch { return {}; }
}
async function api(route, { token, method = "GET", body } = {}) {
  const started = Date.now();
  const response = await fetch(API + route, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`API ${route}: HTTP ${response.status} ${data.error || ""}`);
  if (route === "/health" && (data.database !== "ok" || Date.now() - started > 1500)) throw new Error("Silver health or response time degraded");
  return data;
}
async function guard(extraBytes = 0) {
  if (stopRequested) throw new Error("Stopped by operator");
  if (pm2Pid() !== baselinePid) throw new Error("Silver process changed; migration halted");
  await api("/health");
  const stat = fs.statfsSync(workdir);
  const free = Number(stat.bavail) * Number(stat.bsize);
  if (free < extraBytes + 1300 * 1024 * 1024) throw new Error("Disk safety margin below 1.3GB");
  const match = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m);
  if (!match || Number(match[1]) < 500 * 1024) throw new Error("Memory guard: below 500MiB");
  if (os.loadavg()[0] > 3.0) throw new Error("Server load too high; migration paused");
}
async function waitForCapacity(extraBytes = 0) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try { return await guard(extraBytes); }
    catch (error) {
      if (!/Server load too high/.test(error.message) || attempt === 11) throw error;
      console.log(`waiting for CPU load to settle (${os.loadavg()[0].toFixed(2)}); service health checked`);
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
}
function tos(env) {
  const { TosClient } = require("@volcengine/tos-sdk");
  const cfg = { ...fileEnv("/etc/itinerary-admin.env"), ...fileEnv("/opt/learning-upload/tos.env"), ...env };
  for (const key of ["TOS_ACCESS_KEY_ID", "TOS_SECRET_ACCESS_KEY", "TOS_BUCKET", "TOS_ENDPOINT"]) if (!cfg[key]) throw new Error(`Missing ${key}`);
  return { client: new TosClient({ accessKeyId: cfg.TOS_ACCESS_KEY_ID, accessKeySecret: cfg.TOS_SECRET_ACCESS_KEY, bucket: cfg.TOS_BUCKET, region: cfg.TOS_REGION || "cn-beijing", endpoint: cfg.TOS_ENDPOINT }), bucket: cfg.TOS_BUCKET };
}
function sizeFromHead(value) {
  const d = value.data || value;
  const n = Number(d["content-length"] || d.contentLength || d.ContentLength || value.headers?.["content-length"]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("TOS HEAD missing size");
  return n;
}
async function cdnReady(url, size, mime) {
  for (let n = 0; n < 5; n++) {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(12000) });
    if (response.ok && Number(response.headers.get("content-length")) === size && (response.headers.get("content-type") || "").includes(mime)) return;
    if (n < 4) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`CDN HEAD/size/type not ready: ${mime}`);
}
async function adminToken(env) {
  const db = await mysql.createConnection({ host: env.DB_HOST || "127.0.0.1", user: env.DB_USER || "silver", password: env.DB_PASS || "", database: env.DB_NAME || "silver", port: Number(env.DB_PORT || 3306) });
  try {
    const [rows] = await db.query("SELECT s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.id='u_admin' AND u.role='admin' AND u.status='active' AND s.expires_at>NOW() ORDER BY s.created_at DESC LIMIT 1");
    if (!rows.length) throw new Error("No active HQ admin session");
    await api("/admin/activity-projects", { token: rows[0].token });
    return rows[0].token;
  } finally { await db.end(); }
}
async function download(url, destination, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2 * 60 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Source download HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) !== expected) throw new Error("Source length changed before download");
  const digest = crypto.createHash("sha256");
  let bytes = 0;
  let checked = Date.now();
  const meter = new Transform({ transform(chunk, _encoding, cb) {
    bytes += chunk.length;
    if (bytes > expected) return cb(new Error("Source exceeded expected size"));
    digest.update(chunk);
    if (Date.now() - checked > 20000) {
      checked = Date.now();
      guard().then(() => cb(null, chunk), cb);
    } else cb(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (bytes !== expected) throw new Error(`Source truncated: ${bytes}/${expected}`);
  return digest.digest("hex");
}
function probe(file) {
  const raw = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json", file], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const data = JSON.parse(raw);
  return { duration: Number(data.format.duration), video: data.streams.find(s => s.codec_type === "video"), audio: data.streams.find(s => s.codec_type === "audio") };
}
async function upload(client, bucket, key, file, type) {
  const size = fs.statSync(file).size;
  let exists = false;
  try {
    const existingSize = sizeFromHead(await client.headObject({ bucket, key }));
    if (existingSize !== size) throw new Error(`Existing target size differs: ${key}`);
    exists = true;
  }
  catch (error) { if (error.statusCode !== 404 && error.code !== "NoSuchKey") throw error; }
  if (!exists) await client.putObjectFromFile({ bucket, key, filePath: file, contentLength: size, contentType: type,
    cacheControl: "public, max-age=31536000, immutable", contentDisposition: "inline" });
  if (sizeFromHead(await client.headObject({ bucket, key })) !== size) throw new Error("TOS uploaded size mismatch");
  return size;
}
async function sha256(file) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function main() {
  baselinePid = pm2Pid();
  if (!baselinePid || baselinePid < 2) throw new Error("Silver PM2 process is not running");
  const env = serviceEnv();
  await waitForCapacity();
  const token = run ? await adminToken(env) : null;
  const project = run
    ? (await api("/admin/activity-projects", { token })).projects.find(p => p.id === ID)
    : (await api(`/public/activity-projects/${ID}`)).project;
  if (!project) throw new Error("Shaoxing album not found");
  if (run) saveOnce(backupFile, { at: new Date().toISOString(), project });
  saveOnce(manifestFile, (project.media || []).map((m, index) => ({ index, type: m.type, url: m.url, size: m.size, poster: m.poster || "" }))
    .filter(x => x.type === "video"));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.length !== 36 || manifest.some(m => !m.url.startsWith(`${VIDEO_BASE}/`))) throw new Error("Expected exactly 36 Shaoxing videos");
  console.log(`plan: ${manifest.length} Shaoxing videos, run=${run}, only=${onlyIndex ?? "all"}, limit=${limit}`);
  if (!run) return;
  const { client, bucket } = tos(env);
  let processed = 0;
  for (const item of manifest) {
    if (onlyIndex !== null && item.index !== onlyIndex) continue;
    if (journal().some(x => x.index === item.index && x.phase === "published")) continue;
    if (processed >= limit) break;
    await waitForCapacity();
    const live = (await api(`/public/activity-projects/${ID}`)).project.media[item.index];
    if (!live || live.url !== item.url) throw new Error(`Media #${item.index} changed; stop before overwrite`);
    const head = await fetch(item.url, { method: "HEAD", signal: AbortSignal.timeout(12000) });
    const sourceSize = Number(head.headers.get("content-length"));
    if (!head.ok || !Number.isSafeInteger(sourceSize) || sourceSize <= 0 || sourceSize > 2 * 1024 ** 3 || item.size && item.size !== sourceSize) throw new Error(`Source #${item.index} size changed`);
    await waitForCapacity(sourceSize + MAX_OUTPUT + 100 * 1024 * 1024);
    const source = path.join(workdir, `source-${item.index}.video`);
    const output = path.join(workdir, `delivery-${item.index}.mp4`);
    const posterFile = path.join(workdir, `poster-${item.index}.jpg`);
    if ([source, output, posterFile].some(fs.existsSync)) throw new Error(`Temporary file already exists for #${item.index}; inspect before retry`);
    try {
      const sourceHash = await download(item.url, source, sourceSize);
      const before = probe(source);
      console.log(`processing #${item.index}: ${(sourceSize / 1024 ** 2).toFixed(1)}MiB, ${before.duration.toFixed(1)}s`);
      const outputSize = await processVideo(source, output);
      const posterSize = await processVideoPoster(output, posterFile);
      const after = probe(output);
      if (after.video?.codec_name !== "h264" || after.video.pix_fmt !== "yuv420p" || after.audio && after.audio.codec_name !== "aac" ||
          Math.abs(after.duration - before.duration) > Math.max(1, before.duration * .02) || outputSize <= 0 || outputSize >= MAX_OUTPUT) {
        throw new Error(`Delivery format/duration/size failed for #${item.index}`);
      }
      const fingerprint = await sha256(output);
      const stem = `project_${ID}_${item.index}_${sourceHash.slice(0, 12)}`;
      const videoKey = `silver-project-videos/${stem}.mp4`;
      const posterKey = `silver-project-images/${stem}_poster.jpg`;
      const url = `${VIDEO_BASE}/${stem}.mp4`;
      const poster = `${IMAGE_BASE}/${stem}_poster.jpg`;
      // A prior retry might have uploaded one object. Existing names are accepted
      // only after matching local output length; sources are never overwritten.
      await upload(client, bucket, videoKey, output, "video/mp4");
      await upload(client, bucket, posterKey, posterFile, "image/jpeg");
      append({ phase: "uploaded", index: item.index, url, poster, sourceSize, sourceHash, size: outputSize, posterSize, fingerprint, duration: after.duration });
      await cdnReady(url, outputSize, "video/mp4");
      await cdnReady(poster, posterSize, "image/jpeg");
      await waitForCapacity();
      const switched = await api(`/admin/activity-projects/${ID}/media/${item.index}/delivery`, {
        token, method: "PATCH", body: { oldUrl: item.url, url, poster, size: outputSize, fingerprint }
      });
      if (switched.media?.url !== url || switched.media?.poster !== poster) throw new Error("API did not acknowledge MP4 and poster");
      const readback = (await api(`/public/activity-projects/${ID}`)).project.media[item.index];
      if (readback.url !== url || readback.poster !== poster || readback.size !== outputSize) throw new Error("Public album did not reflect delivery");
      append({ phase: "published", index: item.index, url, poster, sourceSize, size: outputSize, posterSize });
      processed++;
      console.log(`published #${item.index}: ${sourceSize} -> ${outputSize} bytes; poster ${posterSize}; health ok`);
    } finally {
      for (const file of [source, output, posterFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  await waitForCapacity();
  console.log(`batch complete: ${journal().filter(x => x.phase === "published").length}/36; Silver healthy`);
}
main().catch(error => { console.error(`STOP: ${error.message}`); process.exitCode = 1; });
