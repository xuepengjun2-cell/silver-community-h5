#!/usr/bin/env node
"use strict";

// One-time, manifest-bound maintenance. Never stops/starts PM2 or deletes media.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const ROOT = "/var/www/silver-community-h5";
const BASE = "https://proj2.likeduoduiyi.cn";
const TABLES = ["users", "activities", "posts", "cases", "activity_projects"];
const MAX_VIDEO = 190 * 1024 * 1024;
class SafeError extends Error {}
function stop(message) { throw new SafeError(message); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sourceKey(url, kind = "video") {
  const prefix = kind === "video" ? "silver-project-videos" : kind === "image" ? "silver-project-images" : "";
  if (!prefix || typeof url !== "string" || !url.startsWith(`${BASE}/${prefix}/`)) stop("Untrusted media URL");
  const name = url.slice(`${BASE}/${prefix}/`.length);
  if (!name || /[?#/\\\x00-\x20]/.test(name)) stop("Invalid media URL");
  let decoded;
  try { decoded = decodeURIComponent(name); } catch { stop("Invalid media encoding"); }
  if (!decoded || /[/\\\x00-\x1f]/.test(decoded) || decoded === "." || decoded === "..") stop("Invalid object name");
  return `${prefix}/${decoded}`;
}
function newUrl(item, poster = false) {
  return `${BASE}/${poster ? "silver-project-images" : "silver-project-videos"}/${encodeURIComponent(poster ? item.posterFilename : item.newFilename)}`;
}
function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 100) stop("Invalid manifest");
  const slots = new Set(), sources = new Set(), names = new Set();
  for (const item of manifest.items) {
    if (!item || !/^project_[a-zA-Z0-9_-]+$/.test(item.projectId || "") || !Number.isSafeInteger(item.index) || item.index < 0) stop("Invalid media target");
    sourceKey(item.sourceUrl);
    if (!Number.isSafeInteger(item.sourceSize) || item.sourceSize <= 200 * 1024 * 1024 || item.sourceSize > 2 * 1024 ** 3) stop("Invalid source size");
    if (!Number.isSafeInteger(item.newSize) || item.newSize <= 0 || item.newSize >= MAX_VIDEO || item.newSize >= item.sourceSize) stop("Invalid delivery size");
    if (!Number.isSafeInteger(item.posterSize) || item.posterSize <= 0 || item.posterSize > 3 * 1024 ** 2) stop("Invalid poster size");
    for (const key of ["sourceSha256", "newSha256", "posterSha256"]) if (!/^[a-f0-9]{64}$/.test(item[key] || "")) stop("Invalid SHA256");
    if (typeof item.sourceEtag !== "string" || !item.sourceEtag || item.sourceEtag.length > 256 || /[\r\n\x00]/.test(item.sourceEtag)) stop("Invalid source ETag");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.mp4$/.test(item.newFilename || "") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.jpg$/.test(item.posterFilename || "")) stop("Invalid new filename");
    const slot = `${item.projectId}:${item.index}`;
    if (slots.has(slot) || sources.has(item.sourceUrl) || names.has(item.newFilename) || names.has(item.posterFilename)) stop("Duplicate manifest target");
    if (newUrl(item) === item.sourceUrl) stop("Original object overwrite forbidden");
    slots.add(slot); sources.add(item.sourceUrl); names.add(item.newFilename); names.add(item.posterFilename);
  }
  return manifest;
}
function replacement(entry) {
  return { ...clone(entry.sourceMedia), url: newUrl(entry), size: entry.newSize, fingerprint: entry.newSha256, poster: newUrl(entry, true) };
}
function patchMedia(doc, entries, direction = "replace") {
  if (!["replace", "rollback"].includes(direction) || !doc || !Array.isArray(doc.media)) stop("Invalid media document");
  const output = clone(doc);
  const seen = new Set();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.index) || seen.has(entry.index)) stop("Duplicate or invalid media index");
    seen.add(entry.index);
    const original = entry.sourceMedia;
    if (!original || original.type !== "video" || original.url !== entry.sourceUrl || Number(original.size) && Number(original.size) !== entry.sourceSize) stop("Source media mismatch");
    const expected = direction === "replace" ? original : replacement(entry);
    if (stable(output.media[entry.index]) !== stable(expected)) stop("Media CAS failed");
    output.media[entry.index] = direction === "replace" ? replacement(entry) : clone(original);
  }
  return output;
}
function buildExpectedRows(snapshot, entries, direction = "replace") {
  const output = clone(snapshot);
  if (!Array.isArray(output.activity_projects)) stop("Invalid database snapshot");
  for (const projectId of new Set(entries.map(e => e.projectId))) {
    const row = output.activity_projects.find(r => r.id === projectId);
    if (!row || !row.doc || typeof row.doc !== "object") stop("Target project missing");
    row.doc = patchMedia(row.doc, entries.filter(e => e.projectId === projectId), direction);
  }
  return output;
}
function assertRowsEqual(actual, expected) { if (stable(actual) !== stable(expected)) stop("Business data changed; CAS refused"); }
function assertStartupStable(snapshot) {
  // Mirror the reviewed runtime's normalizeProjectMedia before any process restart.
  // Unknown fields or duplicates would otherwise be silently discarded at startup.
  const clean = value => value == null ? "" : String(value).trim();
  for (const row of snapshot.activity_projects || []) {
    const before = row.doc?.media || [], seen = new Set();
    if (!Array.isArray(before)) stop("Startup would normalize invalid media");
    const after = before.map(raw => {
      if (!raw || !["image", "video"].includes(clean(raw.type).toLowerCase()) || !/^https?:\/\//i.test(clean(raw.url))) return null;
      const type = clean(raw.type).toLowerCase(), url = clean(raw.url), fingerprint = clean(raw.fingerprint || raw.sha256 || raw.hash);
      const identity = fingerprint ? `${type}:${fingerprint}` : `${type}:${url}`;
      if (seen.has(identity)) return null; seen.add(identity);
      const media = { type, url, title: clean(raw.title || raw.name), caption: clean(raw.caption || raw.description), createdAt: clean(raw.createdAt) };
      if (!media.createdAt) stop("Startup would add media timestamp");
      if (fingerprint) media.fingerprint = fingerprint;
      const size = Number(raw.size || 0); if (Number.isFinite(size) && size > 0) media.size = size;
      const poster = clean(raw.poster); if (type === "video" && poster.startsWith(`${BASE}/silver-project-images/`)) media.poster = poster;
      return media;
    }).filter(Boolean);
    if (stable(before) !== stable(after)) stop("Startup would change existing media; maintenance refused");
  }
}
function safePath(value, kind) {
  const prefix = kind === "work" ? "/var/tmp" : kind === "backup" ? "/var/backups" : "";
  if (!prefix || typeof value !== "string" || !new RegExp(`^${prefix}/silver-album-maintenance-[a-zA-Z0-9.-]+$`).test(value) || path.resolve(value) !== value) stop("Unsafe maintenance directory");
  return value;
}
function resolveTosEndpoint(endpoint, region, network = "public") {
  if (!["public", "internal"].includes(network)) stop("Invalid TOS network");
  if (network === "public") return endpoint;
  const hostname = String(endpoint || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (region !== "cn-beijing" || hostname !== "tos-cn-beijing.volces.com") stop("Internal TOS requires verified official Beijing configuration");
  return "tos-cn-beijing.ivolces.com";
}
function assertTosNetwork(state, network = "public") {
  if (!state || typeof state !== "object" || !["public", "internal"].includes(network)) stop("Invalid TOS network binding");
  const bound = Object.hasOwn(state, "tosNetwork") ? state.tosNetwork : "public";
  if (!["public", "internal"].includes(bound) || bound !== network) stop("Backup TOS network differs from requested network");
  return bound;
}
function validateOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const match = args[i].match(/^--(mode|work|backup|manifest|tos-network)(?:=(.*))?$/);
    const key = match?.[1] === "tos-network" ? "tosNetwork" : match?.[1];
    if (!match || Object.hasOwn(result, key)) stop("Invalid argument");
    const value = match[2] === undefined ? args[++i] : match[2];
    if (!value || value.startsWith("--")) stop("Missing argument");
    result[key] = value;
  }
  if (!Object.hasOwn(result, "tosNetwork")) result.tosNetwork = "public";
  if (!["public", "internal"].includes(result.tosNetwork)) stop("Invalid TOS network");
  if (!["audit", "backup", "stage", "replace", "verify", "rollback"].includes(result.mode)) stop("Invalid mode");
  safePath(result.work, "work");
  if (result.mode !== "audit") {
    safePath(result.backup, "backup");
    if (!result.manifest || path.dirname(result.manifest) !== result.work || path.basename(result.manifest) !== "manifest.json") stop("Manifest must be work/manifest.json");
  }
  return result;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) stop("Expected regular file");
  return stat;
}
function assertDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) stop("Unsafe directory");
}
function assertPrivateFile(file) {
  if ((regular(file).mode & 0o777) !== 0o600 || (fs.lstatSync(path.dirname(file)).mode & 0o777) !== 0o700) stop("Private backup permissions invalid");
  assertDirectory(path.dirname(file));
}
function readJson(file, privateFile = false) {
  privateFile ? assertPrivateFile(file) : regular(file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writePrivate(file, value) { fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 }); }
function processInfo(requireOnline) {
  const list = JSON.parse(execFileSync("pm2", ["jlist"], { maxBuffer: 8 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] }));
  const matches = list.filter(p => p.name === "silver");
  if (matches.length !== 1) stop("Expected exactly one silver process");
  const p = matches[0];
  if (p.pm2_env.pm_cwd !== ROOT || p.pm2_env.pm_exec_path !== `${ROOT}/server.js`) stop("Unexpected silver runtime");
  if (requireOnline) {
    if (p.pm2_env.status !== "online" || !Number.isSafeInteger(p.pid) || p.pid <= 0) stop("Silver must be online");
  } else {
    if (p.pm2_env.status !== "stopped" || p.pid) stop("Stop silver before database mutation");
    const pids = fs.readdirSync("/proc").filter(n => /^\d+$/.test(n));
    for (const pid of pids) {
      let cwd;
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
      if (cwd !== ROOT) continue;
      let command;
      try { command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
      if (command.some(a => a === `${ROOT}/server.js` || a === "server.js")) stop("Old silver process still running");
    }
  }
  return p;
}
function liveEnv() {
  const p = processInfo(true), env = {};
  for (const field of fs.readFileSync(`/proc/${p.pid}/environ`, "utf8").split("\0")) {
    const index = field.indexOf("="); if (index > 0) env[field.slice(0, index)] = field.slice(index + 1);
  }
  if (Number(env.PORT || 5174) !== 5174) stop("Unexpected runtime port");
  return env;
}
function envFile(file) {
  if (!fs.existsSync(file)) return {};
  const output = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) output[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return output;
}
function tos(env, network = "public") {
  const cfg = { ...envFile("/etc/itinerary-admin.env"), ...envFile("/opt/learning-upload/tos.env"), ...env };
  if (!["TOS_ACCESS_KEY_ID", "TOS_SECRET_ACCESS_KEY", "TOS_BUCKET", "TOS_ENDPOINT"].every(k => cfg[k])) stop("TOS configuration unavailable");
  const endpoint = resolveTosEndpoint(cfg.TOS_ENDPOINT, cfg.TOS_REGION || "cn-beijing", network);
  const { TosClient } = require(`${ROOT}/node_modules/@volcengine/tos-sdk`);
  return { bucket: cfg.TOS_BUCKET, client: new TosClient({ accessKeyId: cfg.TOS_ACCESS_KEY_ID, accessKeySecret: cfg.TOS_SECRET_ACCESS_KEY, endpoint, region: cfg.TOS_REGION || "cn-beijing", requestTimeout: 120000, maxRetryCount: 0 }) };
}
async function database(env) {
  return require(`${ROOT}/node_modules/mysql2/promise`).createConnection({ host: env.DB_HOST || "127.0.0.1", port: Number(env.DB_PORT || 3306), user: env.DB_USER || "silver", password: env.DB_PASS || "", database: env.DB_NAME || "silver", connectTimeout: 10000 });
}
async function rows(conn, locked = false) {
  const output = {};
  for (const table of TABLES) {
    const [items] = await conn.query(`SELECT * FROM \`${table}\` ORDER BY id${locked ? " FOR UPDATE" : ""}`);
    output[table] = items.map(row => ({ ...row, doc: typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc }));
  }
  return output;
}
async function idle(conn) {
  for (const table of ["project_upload_sessions", "case_direct_upload_sessions"]) {
    const [[result]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table} WHERE status IN ('uploading','processing')`);
    if (Number(result.n)) stop("Active uploads; defer maintenance");
  }
  const file = `${ROOT}/data/miniapp-video-jobs.json`;
  if (fs.existsSync(file)) {
    const jobs = readJson(file);
    if (!Array.isArray(jobs) || jobs.some(j => ["receiving", "queued", "processing"].includes(j.status))) stop("Active video jobs; defer maintenance");
  }
}
function headInfo(result) {
  const headers = result.headers || {};
  const size = Number(headers["content-length"] ?? result.data?.["content-length"] ?? result.data?.ContentLength);
  const etag = headers.etag || headers.ETag || result.data?.etag || result.data?.ETag;
  if (!Number.isSafeInteger(size) || size <= 0 || !etag) stop("Invalid origin HEAD");
  return { size, etag };
}
async function head(t, key) { return headInfo(await t.client.headObject({ bucket: t.bucket, key })); }
async function sourceGuard(t, item, digest = false) {
  const key = sourceKey(item.sourceUrl), info = await head(t, key);
  if (info.size !== item.sourceSize || info.etag !== item.sourceEtag) stop("Original object changed");
  if (digest) {
    const url = t.client.getPreSignedUrl({ bucket: t.bucket, key, method: "GET", expires: 7200 });
    await fetchHash(url, item.sourceSha256, item.sourceSize, { "If-Match": info.etag });
    const again = await head(t, key);
    if (again.size !== info.size || again.etag !== info.etag) stop("Original object changed during verification");
  }
}
async function fetchHash(url, expectedHash, expectedSize, headers = {}) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (response.status !== 200 || !response.body) stop("Media readback failed");
  const digest = crypto.createHash("sha256"); let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > expectedSize) stop("Media readback exceeds expected size");
    digest.update(chunk);
  }
  if (size !== expectedSize || digest.digest("hex") !== expectedHash) stop("Media readback SHA256 mismatch");
}
async function verifyObject(t, key, url, size, sha256) {
  const before = await head(t, key);
  if (before.size !== size) stop("New origin size mismatch");
  await fetchHash(t.client.getPreSignedUrl({ bucket: t.bucket, key, method: "GET", expires: 7200 }), sha256, size);
  await fetchHash(url, sha256, size);
  const after = await head(t, key);
  if (after.size !== before.size || after.etag !== before.etag) stop("New object changed during readback");
  return before;
}
async function fileHash(file) {
  regular(file); const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
function loadState(o, manifest) {
  const state = readJson(`${o.backup}/state.json`, true);
  assertTosNetwork(state, o.tosNetwork);
  if (state.version !== 1 || state.manifestHash !== hash(stable(manifest)) || state.work !== o.work) stop("Backup is for a different manifest");
  const snapshot = readJson(`${o.backup}/business.json`, true);
  if (hash(stable(snapshot)) !== state.snapshotHash) stop("Backup snapshot corrupted");
  const env = readJson(`${o.backup}/effective-env.json`, true);
  if (hash(stable(env)) !== state.envHash) stop("Backup environment corrupted");
  for (const item of state.entries) {
    const original = snapshot.activity_projects.find(r => r.id === item.projectId);
    if (!original || hash(stable(original.doc)) !== item.projectHash || stable(original.doc.media[item.index]) !== stable(item.sourceMedia)) stop("Backup media corrupted");
  }
  if (state.entries.length !== manifest.items.length || state.entries.some((e, i) => stable(Object.fromEntries(Object.keys(manifest.items[i]).map(k => [k, e[k]]))) !== stable(manifest.items[i]))) stop("Backup manifest entries corrupted");
  return { state, snapshot, env };
}
async function main(args = process.argv.slice(2)) {
  const o = validateOptions(args);
  assertDirectory(o.work);
  if (o.mode === "audit") {
    const env = liveEnv(), conn = await database(env);
    try {
      const t = tos(env, o.tosNetwork), inventory = [];
      const [projects] = await conn.query("SELECT id, doc FROM activity_projects ORDER BY id");
      for (const row of projects) {
        const doc = typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc;
        for (const [index, media] of (doc.media || []).entries()) {
          if (media.type !== "video") continue;
          const key = sourceKey(media.url), info = await head(t, key);
          inventory.push({ projectId: row.id, index, media, sourceKey: key, sourceSize: info.size, sourceEtag: info.etag });
        }
      }
      process.stdout.write(`${JSON.stringify({ version: 1, inventory })}\n`);
    } finally { await conn.end(); }
    return;
  }
  const manifest = validateManifest(readJson(o.manifest));
  if (o.mode === "backup") {
    if (fs.existsSync(o.backup)) stop("Backup directory already exists");
    const env = liveEnv(), conn = await database(env);
    try {
      await idle(conn);
      await conn.query("SET TRANSACTION READ ONLY"); await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      const snapshot = await rows(conn), t = tos(env, o.tosNetwork), entries = [];
      assertStartupStable(snapshot);
      for (const item of manifest.items) {
        await sourceGuard(t, item);
        const row = snapshot.activity_projects.find(r => r.id === item.projectId);
        if (!row) stop("Target project missing");
        const entry = { ...item, sourceMedia: clone(row.doc.media?.[item.index]), projectHash: hash(stable(row.doc)) };
        patchMedia(row.doc, [entry]); entries.push(entry);
      }
      await conn.rollback();
      fs.mkdirSync(o.backup, { mode: 0o700 }); assertDirectory(o.backup);
      writePrivate(`${o.backup}/effective-env.json`, env);
      writePrivate(`${o.backup}/business.json`, snapshot);
      writePrivate(`${o.backup}/state.json`, { version: 1, work: o.work, tosNetwork: o.tosNetwork, manifestHash: hash(stable(manifest)), snapshotHash: hash(stable(snapshot)), envHash: hash(stable(env)), runtimeHash: await fileHash(`${ROOT}/server.js`), originalPid: processInfo(true).pid, entries, createdAt: new Date().toISOString() });
    } finally { await conn.end(); }
    process.stdout.write('{"mode":"backup","ok":true,"originalObjectsRetained":true}\n'); return;
  }
  assertDirectory(o.backup);
  const { state, snapshot, env } = loadState(o, manifest), t = tos(env, o.tosNetwork);
  if (await fileHash(`${ROOT}/server.js`) !== state.runtimeHash) stop("Server code changed since backup");
  if (o.mode === "stage") {
    processInfo(true); assertDirectory(`${o.work}/files`);
    if (hash(stable(liveEnv())) !== state.envHash) stop("Runtime environment changed since backup");
    const previousStage = fs.existsSync(`${o.backup}/staged.json`) ? readJson(`${o.backup}/staged.json`, true) : null;
    if (previousStage && previousStage.manifestHash !== state.manifestHash) stop("Existing stage belongs to another manifest");
    const objects = [];
    for (const item of manifest.items) {
      await sourceGuard(t, item, true);
      for (const poster of [false, true]) {
        const filename = poster ? item.posterFilename : item.newFilename, size = poster ? item.posterSize : item.newSize, sha256 = poster ? item.posterSha256 : item.newSha256;
        const file = `${o.work}/files/${filename}`, key = sourceKey(newUrl(item, poster), poster ? "image" : "video");
        if (regular(file).size !== size || await fileHash(file) !== sha256) stop("Staged local file mismatch");
        let exists = false;
        try { await head(t, key); exists = true; }
        catch (error) { if (error.statusCode !== 404) throw error; }
        if (!exists) {
          try {
            await t.client.putObjectFromFile({ bucket: t.bucket, key, filePath: file, contentLength: size, contentType: poster ? "image/jpeg" : "video/mp4", cacheControl: "public, max-age=31536000, immutable", contentDisposition: "inline", ifNoneMatch: "*", headers: { "If-None-Match": "*" }, forbidOverwrite: true });
          } catch (error) {
            // A prior interrupted run or concurrent creator may own this key.
            // Adopt it only after full origin AND CDN digest checks below.
            if (![409, 412].includes(error.statusCode)) throw error;
          }
        }
        const verified = await verifyObject(t, key, newUrl(item, poster), size, sha256);
        objects.push({ key, size, sha256, etag: verified.etag });
      }
    }
    if (previousStage) {
      if (stable(previousStage.objects) !== stable(objects)) stop("Previously staged object identity changed");
    } else writePrivate(`${o.backup}/staged.json`, { manifestHash: state.manifestHash, objects, completedAt: new Date().toISOString() });
  } else if (o.mode === "replace" || o.mode === "rollback") {
    processInfo(false);
    if (!Number.isSafeInteger(state.originalPid) || fs.existsSync(`/proc/${state.originalPid}`)) stop("Original server process has not exited");
    const staged = readJson(`${o.backup}/staged.json`, true);
    if (staged.manifestHash !== state.manifestHash) stop("Staging not verified");
    for (const item of manifest.items) await sourceGuard(t, item);
    if (o.mode === "replace") {
      if (!Array.isArray(staged.objects) || staged.objects.length !== manifest.items.length * 2) stop("Staged object inventory invalid");
      for (const item of manifest.items) for (const poster of [false, true]) {
        const key = sourceKey(newUrl(item, poster), poster ? "image" : "video"), object = staged.objects.find(value => value.key === key);
        const size = poster ? item.posterSize : item.newSize, sha256 = poster ? item.posterSha256 : item.newSha256;
        if (!object || object.size !== size || object.sha256 !== sha256 || !object.etag) stop("Staged object manifest mismatch");
        const current = await head(t, key);
        if (current.etag !== object.etag || current.size !== size) stop("Staged object changed after verification");
      }
    }
    const conn = await database(env);
    try {
      await idle(conn); await conn.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"); await conn.beginTransaction();
      const current = await rows(conn, true), replaced = buildExpectedRows(snapshot, state.entries);
      assertStartupStable(replaced);
      assertRowsEqual(current, o.mode === "replace" ? snapshot : replaced);
      const expected = o.mode === "replace" ? replaced : snapshot;
      for (const projectId of new Set(state.entries.map(e => e.projectId))) {
        const row = expected.activity_projects.find(r => r.id === projectId);
        const [result] = await conn.query("UPDATE activity_projects SET doc = ? WHERE id = ?", [JSON.stringify(row.doc), projectId]);
        if (result.affectedRows !== 1) stop("Project update count mismatch");
      }
      assertRowsEqual(await rows(conn), expected);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; } finally { await conn.end(); }
  } else if (o.mode === "verify") {
    processInfo(true);
    const conn = await database(env);
    try { assertRowsEqual(await rows(conn), buildExpectedRows(snapshot, state.entries)); } finally { await conn.end(); }
    for (const apiBase of ["http://127.0.0.1:5174/api", "https://apip2.opensplendid.com/silver-api"]) {
      const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(10000) }), health = await response.json();
      if (response.status !== 200 || health.ok !== true || health.database !== "ok" || health.service !== "silver") stop("Health verification failed");
      for (const projectId of new Set(state.entries.map(e => e.projectId))) {
        const original = snapshot.activity_projects.find(row => row.id === projectId).doc;
        if (original.status !== "published" || original.shareEnabled === false) continue;
        const result = await fetch(`${apiBase}/public/activity-projects/${encodeURIComponent(projectId)}`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(10000) });
        if (result.status !== 200) stop("Public album verification failed");
        const data = await result.json(), doc = data.project;
        if (!doc || !Array.isArray(doc.media)) stop("Public album response invalid");
        for (const entry of state.entries.filter(e => e.projectId === projectId)) if (stable(doc.media[entry.index]) !== stable(replacement(entry))) stop("API media cache differs from database");
      }
    }
    for (const item of manifest.items) {
      await sourceGuard(t, item);
      await verifyObject(t, sourceKey(newUrl(item)), newUrl(item), item.newSize, item.newSha256);
      await verifyObject(t, sourceKey(newUrl(item, true), "image"), newUrl(item, true), item.posterSize, item.posterSha256);
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: o.mode, ok: true, items: manifest.items.length, originalObjectsRetained: true })}\n`);
}
module.exports = { stable, hash, validateManifest, sourceKey, newUrl, replacement, patchMedia, buildExpectedRows, assertRowsEqual, assertStartupStable, resolveTosEndpoint, assertTosNetwork, validateOptions, safePath, assertPrivateFile, main };
if (require.main === module) main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof SafeError ? error.message : "Maintenance failed; credentials and raw errors withheld" })}\n`); process.exitCode = 1; });
