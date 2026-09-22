#!/usr/bin/env node
"use strict";

// Deletes only the 36 frozen Shaoxing source objects, and only after their
// replacement MP4 + first-frame poster are published and independently read back.
// Dry-run is the default. This is deliberately separate from the running converter.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const mysql = require("mysql2/promise");

const ID = "project_85aae4b746069044";
const API = "http://127.0.0.1:5174/api";
const VIDEO_BASE = "https://proj2.likeduoduiyi.cn/silver-project-videos/";
const IMAGE_BASE = "https://proj2.likeduoduiyi.cn/silver-project-images/";
const args = process.argv.slice(2);
const workArg = args.find(s => s.startsWith("--workdir="));
const workdir = workArg && path.resolve(workArg.slice(10));
const run = args.includes("--run");
const onlyArg = args.find(s => s.startsWith("--only-index="));
const onlyIndex = onlyArg ? Number(onlyArg.slice(13)) : null;
const journalFile = workdir && path.join(workdir, "journal.jsonl");
const cleanupFile = workdir && path.join(workdir, "cleanup.jsonl");

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}
function record(entry) {
  const fd = fs.openSync(cleanupFile, "a", 0o600);
  try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function validateManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length !== 36 ||
      manifest.some((item, i) => item.index !== i + 1 || item.type !== "video" ||
        !/^https:\/\/proj2\.likeduoduiyi\.cn\/silver-project-videos\/[A-Za-z0-9._%-]+\.(mov|mp4)$/i.test(item.url)) ||
      new Set(manifest.map(item => item.url)).size !== 36) throw new Error("Frozen 36-item Shaoxing manifest is invalid");
  return manifest;
}
function candidate(item, events) {
  const uploaded = events.filter(e => e.index === item.index && e.phase === "uploaded");
  const published = events.filter(e => e.index === item.index && e.phase === "published");
  if (!published.length) return null;
  if (!uploaded.length || published.length !== 1) throw new Error(`Ambiguous journal for #${item.index}`);
  const u = uploaded[0], p = published[0];
  // A retry may have uploaded exactly the same two immutable objects twice
  // before the compare-and-swap publication succeeded; divergent retries stop.
  if (uploaded.some(e => ["url", "poster", "size", "posterSize", "sourceSize", "sourceHash", "fingerprint", "duration"]
    .some(field => e[field] !== u[field]))) throw new Error(`Conflicting upload attempts for #${item.index}`);
  if (u.url !== p.url || u.poster !== p.poster || u.size !== p.size || u.posterSize !== p.posterSize ||
      u.sourceSize !== p.sourceSize || !Number.isSafeInteger(u.sourceSize) || u.sourceSize <= 0 ||
      !Number.isSafeInteger(u.size) || u.size <= 0 || u.size >= 190 * 1024 * 1024 ||
      !Number.isSafeInteger(u.posterSize) || u.posterSize <= 0 || u.posterSize > 3 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(u.fingerprint) || !/^[a-f0-9]{64}$/.test(u.sourceHash) ||
      !u.url.startsWith(VIDEO_BASE) || !/\.mp4$/.test(u.url) ||
      !u.poster.startsWith(IMAGE_BASE) || !/\.jpe?g$/.test(u.poster) ||
      u.url === item.url) throw new Error(`Invalid replacement evidence for #${item.index}`);
  const stem = `project_${ID}_${item.index}_${u.sourceHash.slice(0, 12)}`;
  if (u.url !== VIDEO_BASE + stem + ".mp4" || u.poster !== IMAGE_BASE + stem + "_poster.jpg") {
    throw new Error(`Replacement object key mismatch for #${item.index}`);
  }
  return { item, uploaded: u };
}
function pm2Env() {
  const pid = Number(execFileSync("pm2", ["pid", "silver"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Silver service is not running");
  return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean)
    .map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
}
function fileEnv(file) {
  try { return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter(s => s.trim() && !s.trim().startsWith("#") && s.includes("="))
    .map(s => { const i = s.indexOf("="); return [s.slice(0, i).trim(), s.slice(i + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, (_m, a, b) => a || b || "")]; })); }
  catch { return {}; }
}
function tos(env) {
  const { TosClient } = require("@volcengine/tos-sdk");
  const cfg = { ...fileEnv("/etc/itinerary-admin.env"), ...fileEnv("/opt/learning-upload/tos.env"), ...env };
  for (const key of ["TOS_ACCESS_KEY_ID", "TOS_SECRET_ACCESS_KEY", "TOS_BUCKET", "TOS_ENDPOINT"]) if (!cfg[key]) throw new Error(`Missing ${key}`);
  return { client: new TosClient({ accessKeyId: cfg.TOS_ACCESS_KEY_ID, accessKeySecret: cfg.TOS_SECRET_ACCESS_KEY,
    bucket: cfg.TOS_BUCKET, region: cfg.TOS_REGION || "cn-beijing", endpoint: cfg.TOS_ENDPOINT }), bucket: cfg.TOS_BUCKET };
}
async function api(route) {
  const response = await fetch(API + route, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`API ${route} HTTP ${response.status}`);
  return response.json();
}
async function health() {
  const started = Date.now();
  const data = await api("/health");
  if (!data.ok || data.database !== "ok" || Date.now() - started > 1500) throw new Error("Silver service health degraded");
}
function sizeOf(head) {
  const value = head.data || head;
  const n = Number(value["content-length"] || value.contentLength || value.ContentLength || head.headers?.["content-length"]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("TOS HEAD missing size");
  return n;
}
function keyOf(url, base) {
  if (!url.startsWith(base)) throw new Error("Object is outside its exact expected TOS prefix");
  const tail = url.slice(base.length);
  if (!/^[A-Za-z0-9._%-]+\.(mov|mp4|jpg|jpeg)$/i.test(tail) || tail.includes("..")) throw new Error("Unsafe TOS key");
  return base === IMAGE_BASE ? "silver-project-images/" + tail : "silver-project-videos/" + tail;
}
async function cdnHead(url, size, type) {
  const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(12000) });
  if (!response.ok || Number(response.headers.get("content-length")) !== size ||
      !(response.headers.get("content-type") || "").includes(type)) throw new Error("New CDN object failed size or MIME readback");
}
async function previewRange(url, magic) {
  const response = await fetch(url, { headers: { Range: "bytes=0-31" }, signal: AbortSignal.timeout(12000) });
  if (response.status !== 206 || !/^bytes 0-31\//.test(response.headers.get("content-range") || "")) {
    await response.body?.cancel(); throw new Error("New media range playback not ready");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== 32 || magic && (bytes[0] !== 0xff || bytes[1] !== 0xd8)) throw new Error("New media range content invalid");
}
async function refCount(db, url) {
  const matches = [];
  for (const table of ["users", "activities", "posts", "cases", "activity_projects"]) {
    const [rows] = await db.query(`SELECT id FROM ${table} WHERE LOCATE(?, CAST(doc AS CHAR)) > 0 LIMIT 2`, [url]);
    for (const row of rows) matches.push(`${table}:${row.id}`);
  }
  const [settings] = await db.query("SELECT k FROM site_config WHERE LOCATE(?, CAST(v AS CHAR)) > 0 LIMIT 2", [url]);
  for (const row of settings) matches.push(`site_config:${row.k}`);
  return matches;
}
async function main() {
  if (!workdir || !/^\/var\/tmp\/silver-shaoxing-[a-zA-Z0-9-]+$/.test(workdir)) throw new Error("Dedicated Shaoxing workdir required");
  if (onlyIndex !== null && (!Number.isInteger(onlyIndex) || onlyIndex < 1 || onlyIndex > 36)) throw new Error("Invalid index");
  process.umask(0o077);
  const manifest = validateManifest(readJson(path.join(workdir, "manifest.json")));
  if (!fs.existsSync(path.join(workdir, "album-backup.json"))) throw new Error("Original project backup missing");
  const backup = readJson(path.join(workdir, "album-backup.json"));
  if (backup.project?.id !== ID || manifest.some(m => backup.project.media?.[m.index]?.url !== m.url)) throw new Error("Frozen backup and manifest disagree");
  const events = readLines(journalFile);
  const cleanup = readLines(cleanupFile);
  const candidates = manifest.map(item => candidate(item, events)).filter(Boolean)
    .filter(({ item }) => onlyIndex === null || item.index === onlyIndex);
  if (!candidates.length) { console.log("No published videos eligible for cleanup"); return; }
  const env = pm2Env();
  const db = await mysql.createConnection({ host: env.DB_HOST || "127.0.0.1", user: env.DB_USER || "silver",
    password: env.DB_PASS || "", database: env.DB_NAME || "silver", port: Number(env.DB_PORT || 3306) });
  try {
    const { client, bucket } = tos(env);
    let confirmed = 0, pending = 0;
    for (const { item, uploaded: u } of candidates) {
      const oldKey = keyOf(item.url, VIDEO_BASE);
      const videoKey = keyOf(u.url, VIDEO_BASE), posterKey = keyOf(u.poster, IMAGE_BASE);
      await health();
      const project = (await api(`/public/activity-projects/${ID}`)).project;
      if (!project || project.media?.length !== 37 || project.media[item.index]?.type !== "video" ||
          project.media[item.index].url !== u.url || project.media[item.index].poster !== u.poster ||
          project.media[item.index].size !== u.size || project.media[item.index].fingerprint !== u.fingerprint) {
        throw new Error(`Public album readback mismatch for #${item.index}`);
      }
      if (sizeOf(await client.headObject({ bucket, key: videoKey })) !== u.size ||
          sizeOf(await client.headObject({ bucket, key: posterKey })) !== u.posterSize) {
        throw new Error(`Replacement TOS HEAD mismatch for #${item.index}`);
      }
      await cdnHead(u.url, u.size, "video/mp4");
      await cdnHead(u.poster, u.posterSize, "image/jpeg");
      await previewRange(u.url, false);
      await previewRange(u.poster, true);
      const refs = await refCount(db, item.url);
      if (refs.length) throw new Error(`Old #${item.index} is still referenced: ${refs.join(",")}`);
      if (cleanup.some(x => x.index === item.index && x.phase === "delete_confirmed")) {
        try { await client.headObject({ bucket, key: oldKey }); throw new Error(`Confirmed source #${item.index} has reappeared`); }
        catch (error) { if (error.statusCode !== 404 && error.code !== "NoSuchKey") throw error; }
        confirmed++;
        continue;
      }
      let originalExists = true;
      try { if (sizeOf(await client.headObject({ bucket, key: oldKey })) !== u.sourceSize) throw new Error(`Original #${item.index} changed size`); }
      catch (error) { if (error.statusCode === 404 || error.code === "NoSuchKey") originalExists = false; else throw error; }
      if (!originalExists) {
        if (run) record({ phase: "delete_confirmed", index: item.index, originalBytes: u.sourceSize, preexistingMissing: true });
        confirmed++; console.log(`#${item.index}: source already absent; replacement verified`); continue;
      }
      if (!run) { pending++; console.log(`#${item.index}: eligible; source ${u.sourceSize} bytes, new ${u.size} bytes`); continue; }
      // Recheck live database immediately before each exact-key deletion.
      if ((await refCount(db, item.url)).length) throw new Error(`Old #${item.index} became referenced; stop`);
      await health();
      record({ phase: "delete_requested", index: item.index, originalBytes: u.sourceSize, replacementBytes: u.size });
      await client.deleteObject({ bucket, key: oldKey });
      try { await client.headObject({ bucket, key: oldKey }); throw new Error(`Original #${item.index} still present`); }
      catch (error) { if (error.statusCode !== 404 && error.code !== "NoSuchKey") throw error; }
      await health();
      record({ phase: "delete_confirmed", index: item.index, originalBytes: u.sourceSize, replacementBytes: u.size });
      confirmed++;
      console.log(`#${item.index}: original TOS object removed; replacement and health verified`);
    }
    console.log(`Cleanup ${run ? "executed" : "dry-run"}: ${confirmed} confirmed, ${pending} eligible pending, ${candidates.length} published candidates / 36 originals`);
  } finally { await db.end(); }
}

if (require.main === module) main().catch(error => { console.error(`STOP: ${error.message}`); process.exitCode = 1; });
module.exports = { validateManifest, candidate };
