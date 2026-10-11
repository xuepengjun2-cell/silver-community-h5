#!/usr/bin/env node
"use strict";
// Only explicitly mapped static objects may change. Backend/media/database untouched.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const release = require("./release-from-github.cjs");
const { resolveTosEndpoint } = require("../scripts/replace-album-videos.cjs");
const REPO = "xuepengjun2-cell/silver-community-h5", ROOT = "/var/www/silver-community-h5", HOST = "root@115.190.225.47";
const EXECUTOR = "deploy/release-static-from-github.cjs";
const FILES = ["app.js", "admin.js", "styles.css", "admin.css", "index.html", "admin.html"];
const OBJECTS = [...FILES.map(name => ({ name, source: name, key: `silver/${name}` })),
  { name: "home-root", source: "silver-redirect.html", key: "silver" }, { name: "home-directory", source: "index.html", key: "silver/" },
  { name: "admin-route", source: "admin-redirect.html", key: "silver/admin" }, { name: "admin-directory", source: "admin-redirect.html", key: "silver/admin/" }];
// Exact historical HTML: 659888e1...:public/index.html,
// 3d17be5c...:public/admin.html, 2c992675...:public/admin.html, respectively.
const LEGACY = { "home-root": "8f40f785a0fa34255db471a8c8646e377b58b05c7303bfb9361c189bcaf1dbd9", "admin-route": "201306bb920a434a98e1f818e7e54e2477cd2c2af10b25fa60b104c7503aef52", "admin-directory": "4d6cf8179a80c7b067ad77a880c9564d556e67b32e8b46d92ea033bd3dde0091" };
const MAX_STATIC = 8 * 1024 ** 2;
class StaticError extends Error {}
const fail = message => { throw new StaticError(message); };
const run = (command, args, extra = {}) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 128 * 1024 ** 2, ...extra });
const api = route => JSON.parse(run("gh", ["api", `repos/${REPO}/${route}`]));
function options(args) {
  const filtered = [], result = { network: "public" }; let prefix = false, network = false;
  for (const arg of args) {
    if (arg.startsWith("--prefix=")) { if (prefix || arg !== "--prefix=silver/") fail("Explicit --prefix=silver/ required; no other key prefix allowed"); prefix = true; }
    else if (arg.startsWith("--tos-network=")) { if (network || !/^--tos-network=(public|internal)$/.test(arg)) fail("Invalid TOS network"); result.network = arg.split("=")[1]; network = true; }
    else filtered.push(arg);
  }
  if (!prefix) fail("Explicit --prefix=silver/ required after confirming production keys");
  return { ...release.options(filtered), ...result, prefix: "silver/" };
}
function object(name) { const entry = OBJECTS.find(item => item.name === name); if (!entry) fail("Static filename not whitelisted"); return entry; }
function key(name) { return object(name).key; }
function plan(before, after, target, base, ci, archiveHash, network) {
  return validatePlan({ version: 1, target, base, ci, archiveHash, executorHash: release.hash(fs.readFileSync(`${after}/${EXECUTOR}`)), prefix: "silver/", network,
    files: OBJECTS.map(({ name, source }) => {
      const exists = fs.existsSync(`${before}/public/${source}`);
      if (!exists && !LEGACY[name]) fail("Static base source missing");
      return { name, before: exists ? release.hash(fs.readFileSync(`${before}/public/${source}`)) : LEGACY[name], legacyFallback: !exists, after: release.hash(fs.readFileSync(`${after}/public/${source}`)), size: fs.statSync(`${after}/public/${source}`).size };
    }) });
}
function validatePlan(value) {
  if (!value || value.version !== 1 || value.prefix !== "silver/" || !["public", "internal"].includes(value.network)) fail("Invalid static release plan");
  release.sha(value.target); release.sha(value.base);
  if (value.ci?.head_sha !== value.target || value.ci?.conclusion !== "success") fail("Static CI evidence mismatch");
  for (const field of ["archiveHash", "executorHash"]) if (!/^[a-f0-9]{64}$/.test(value[field] || "")) fail("Invalid static artifact hash");
  if (!Array.isArray(value.files) || value.files.length !== OBJECTS.length || new Set(value.files.map(f => f.name)).size !== OBJECTS.length) fail("Static plan must contain exactly ten unique whitelisted objects");
  for (const item of value.files) {
    key(item.name);
    if (![item.before, item.after].every(h => /^[a-f0-9]{64}$/.test(h || "")) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_STATIC) fail("Invalid static object hash/size");
    if (typeof item.legacyFallback !== "boolean" || item.legacyFallback && (!LEGACY[item.name] || item.before !== LEGACY[item.name])) fail("Static alias first-migration baseline is fixed");
  }
  return value;
}
function assertOrigin(item, actual) { if (actual !== item.before && actual !== item.after && actual !== LEGACY[item.name]) fail(`Static origin drift: ${key(item.name)}; expected=${item.before}|${item.after}${LEGACY[item.name] ? `|${LEGACY[item.name]}` : ""}; actual=${actual}`); }
function metadata(headers) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (Object.keys(h).some(k => /^x-tos-(server-side-encryption|object-lock|legal-hold|retention)/.test(k)) || Number(h["x-tos-tagging-count"] || 0)) fail("Special encrypted/retained/tagged static objects require separate review");
  if (h["content-encoding"] && h["content-encoding"] !== "identity") fail("Encoded static storage needs a separate reviewed release");
  const out = { meta: {} };
  for (const [header, field] of [["content-type", "contentType"], ["cache-control", "cacheControl"], ["content-disposition", "contentDisposition"], ["content-language", "contentLanguage"], ["content-encoding", "contentEncoding"], ["x-tos-storage-class", "storageClass"]]) if (typeof h[header] === "string") out[field] = h[header];
  if (h.expires) { const expires = new Date(h.expires); if (!Number.isFinite(expires.getTime())) fail("Invalid object expiration metadata"); out.expires = expires; }
  for (const [header, value] of Object.entries(h)) if (header.startsWith("x-tos-meta-") && typeof value === "string") out.meta[header.slice(11)] = value;
  if (h["x-tos-website-redirect-location"] || h["x-tos-object-type"] === "Symlink") fail("Static redirect/symlink objects forbidden");
  return out;
}
async function fetchBytes(url, headers = {}) {
  const response = await fetch(url, { headers: { "Accept-Encoding": "identity", ...headers }, redirect: "error", signal: AbortSignal.timeout(60000) });
  if (response.status !== 200 || !response.body) fail("Static full GET failed");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > MAX_STATIC) fail("Static GET exceeds permitted size"); chunks.push(Buffer.from(chunk)); }
  if (!size) fail("Static GET empty"); return Buffer.concat(chunks);
}
async function origin(client, bucket, name) {
  const objectKey = key(name), first = await client.headObject({ bucket, key: objectKey });
  const headers = { ...first.headers, ...first.data }, etag = headers.etag || headers.ETag;
  if (typeof etag !== "string" || !etag || /[\r\n]/.test(etag)) fail("Static origin ETag missing");
  const bytes = await fetchBytes(client.getPreSignedUrl({ bucket, key: objectKey, method: "GET", expires: 300 }), { "If-Match": etag });
  const last = await client.headObject({ bucket, key: objectKey });
  if ((last.data?.etag || last.headers?.etag || last.headers?.ETag) !== etag) fail("Static object changed during GET");
  return { bytes, etag, sha256: release.hash(bytes), metadata: metadata(headers) };
}
async function put(client, bucket, name, bytes, before, meta) {
  return client.putObject({ bucket, key: key(name), body: bytes, contentLength: bytes.length, ...meta, ifMatch: before.etag, headers: { "If-Match": before.etag } });
}
const metaHash = value => release.hash(release.stable(JSON.parse(JSON.stringify(value))));
const aclHash = value => {
  if (!value || !value.Owner || !Array.isArray(value.Grants)) fail("Static ACL unavailable");
  return metaHash({ Owner: value.Owner, Grants: value.Grants.map(release.stable).sort(), BucketOwnerEntrusted: value.BucketOwnerEntrusted || false });
};
function versionedScripts(source, value) {
  return ["index.html", "admin.html"].map(name => {
    const html = fs.readFileSync(`${source}/public/${name}`, "utf8"), expected = name === "index.html" ? "app.js" : "admin.js";
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
    if (scripts.length !== 1) fail("Target HTML must reference exactly one approved versioned script");
    const url = new URL(scripts[0][1], `https://proj2.likeduoduiyi.cn/silver/${name}`);
    if (url.origin !== "https://proj2.likeduoduiyi.cn" || url.pathname !== `/silver/${expected}` || !url.searchParams.get("v") || url.hash || url.username || url.password) fail("Target HTML script URL is not approved/versioned");
    return { url: url.href, sha256: value.files.find(f => f.name === expected).after };
  });
}
async function retryPublic(read, expected, label, immediate) {
  const deadline = Date.now() + 90000;
  while (true) {
    try { if (release.hash(await read()) === expected) return; } catch { /* CDN propagation/network retry, bounded below. */ }
    if (immediate || Date.now() >= deadline) fail(`Static public SHA mismatch: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
async function publish(client, bucket, value, source, backup, apply, dependencies = {}) {
  const scripts = versionedScripts(source, value);
  const read = dependencies.origin || ((name) => origin(client, bucket, name));
  const publicRead = dependencies.publicRead || ((name, cachebust) => fetchBytes(`https://proj2.likeduoduiyi.cn/${key(name)}${cachebust ? `?cachebust=${value.target}` : ""}`));
  const inspected = new Map(), attempted = [];
  for (const item of value.files) {
    const bytes = fs.readFileSync(`${source}/public/${object(item.name).source}`);
    if (bytes.length !== item.size || release.hash(bytes) !== item.after) fail(`GitHub static source mismatch: ${item.name}`);
    const previous = await read(item.name); assertOrigin(item, previous.sha256);
    previous.acl = (await client.getObjectAcl({ bucket, key: key(item.name) })).data; aclHash(previous.acl);
    inspected.set(item.name, previous);
  }
  if (!apply) return { ok: true, dryRun: true, target: value.target, objects: value.files.map(item => ({ key: key(item.name), sha256: inspected.get(item.name).sha256, alreadyTarget: inspected.get(item.name).sha256 === item.after })) };
  fs.mkdirSync(backup, { mode: 0o700 });
  const state = { target: value.target, files: [] };
  for (const item of value.files) {
    const previous = inspected.get(item.name), acl = previous.acl;
    fs.writeFileSync(`${backup}/${encodeURIComponent(key(item.name))}`, previous.bytes, { flag: "wx", mode: 0o600 });
    state.files.push({ name: item.name, sha256: previous.sha256, etag: previous.etag, metadata: previous.metadata, acl });
  }
  fs.writeFileSync(`${backup}/state.json`, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  try {
    for (const { name } of OBJECTS) { // JS, CSS, then HTML aliases; manifest cannot reorder.
      const item = value.files.find(f => f.name === name), previous = inspected.get(name);
      if (previous.sha256 === item.after) continue;
      const current = await read(name);
      if (current.etag !== previous.etag || current.sha256 !== previous.sha256) fail(`Static object changed before upload: ${key(name)}`);
      const token = randomUUID(), nextMeta = { ...previous.metadata, cacheControl: "no-cache, max-age=0, must-revalidate", meta: { ...previous.metadata.meta, "silver-release-id": token } };
      const entry = { item, previous, token, nextMeta }; attempted.push(entry);
      fs.writeFileSync(`${backup}/attempt-${name}.json`, JSON.stringify({ name, token, before: current.etag, target: item.after }), { flag: "wx", mode: 0o600 });
      const response = await put(client, bucket, name, fs.readFileSync(`${source}/public/${object(name).source}`), current, nextMeta);
      entry.etag = response?.headers?.etag || response?.data?.etag;
      const after = await read(name); if (after.sha256 !== item.after) fail(`Static origin readback mismatch: ${key(name)}`);
      if (entry.etag && entry.etag !== after.etag || metaHash(after.metadata) !== metaHash(nextMeta)) fail("Static metadata/concurrent-write check failed");
      entry.etag = after.etag;
      await client.putObjectAcl({ bucket, key: key(name), aclBody: previous.acl });
      entry.aclApplied = true;
      if (aclHash((await client.getObjectAcl({ bucket, key: key(name) })).data) !== aclHash(previous.acl)) fail("Static ACL readback failed");
    }
    const verification = await Promise.allSettled([...value.files.map(async item => {
      const after = await read(item.name);
      if (after.sha256 !== item.after) fail(`Static final origin mismatch: ${key(item.name)}`);
      await Promise.all([true, false].map(cachebust => retryPublic(() => publicRead(item.name, cachebust), item.after, `${key(item.name)} ${cachebust ? "query" : "canonical"}`, !!dependencies.publicRead)));
    }), ...scripts.map(script => retryPublic(() => dependencies.versionedRead ? dependencies.versionedRead(script.url) : fetchBytes(script.url), script.sha256, "HTML versioned script", !!dependencies.versionedRead))]);
    const failed = verification.find(result => result.status === "rejected"); if (failed) throw failed.reason;
    fs.writeFileSync(`${backup}/verified.json`, JSON.stringify({ target: value.target, objects: value.files.map(f => ({ key: key(f.name), sha256: f.after })) }), { flag: "wx", mode: 0o600 });
    return { ok: true, target: value.target, backup, originAndCacheBustedPublicVerified: true, canonicalPublicVerified: true, backendChanged: false, databaseChanged: false };
  } catch (error) {
    try {
      for (const entry of [...attempted].reverse()) {
        const current = await read(entry.item.name);
        if (current.etag === entry.previous.etag && current.sha256 === entry.previous.sha256) continue;
        if (current.sha256 !== entry.item.after || entry.etag && current.etag !== entry.etag || current.metadata.meta?.["silver-release-id"] !== entry.token || metaHash(current.metadata) !== metaHash(entry.nextMeta)) fail("Static rollback CAS refused after external edit");
        if (entry.aclApplied && aclHash((await client.getObjectAcl({ bucket, key: key(entry.item.name) })).data) !== aclHash(entry.previous.acl)) fail("Static rollback ACL CAS refused after external edit");
        await put(client, bucket, entry.item.name, entry.previous.bytes, current, entry.previous.metadata);
        await client.putObjectAcl({ bucket, key: key(entry.item.name), aclBody: entry.previous.acl });
        const restored = await read(entry.item.name);
        if (restored.sha256 !== entry.previous.sha256 || metaHash(restored.metadata) !== metaHash(entry.previous.metadata) || aclHash((await client.getObjectAcl({ bucket, key: key(entry.item.name) })).data) !== aclHash(entry.previous.acl)) fail("Static rollback readback failed");
      }
    } catch { fail(`Static release failed; rollback needs operator attention; backup=${backup}; backend/database untouched`); }
    fail(`Static release failed; own writes rolled back; backup=${backup}; reason=${error instanceof StaticError ? error.message : "TOS operation failed"}; backend/database untouched`);
  }
}
function parseEnv(file) {
  const result = {}; if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/); if (m) result[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2"); }
  return result;
}
function liveTos(network) {
  const list = JSON.parse(run("pm2", ["jlist"])), matches = list.filter(p => p.name === "silver");
  if (matches.length !== 1 || matches[0].pm2_env.pm_cwd !== ROOT || matches[0].pm2_env.pm_exec_path !== `${ROOT}/server.js` || matches[0].pm2_env.status !== "online" || !matches[0].pid) fail("Unexpected silver runtime");
  const env = { ...parseEnv("/etc/itinerary-admin.env"), ...parseEnv("/opt/learning-upload/tos.env") };
  for (const field of fs.readFileSync(`/proc/${matches[0].pid}/environ`, "utf8").split("\0")) { const i = field.indexOf("="); if (i > 0) env[field.slice(0, i)] = field.slice(i + 1); }
  if (!["TOS_ACCESS_KEY_ID", "TOS_SECRET_ACCESS_KEY", "TOS_BUCKET", "TOS_ENDPOINT"].every(k => env[k])) fail("TOS configuration missing");
  const endpoint = resolveTosEndpoint(env.TOS_ENDPOINT, env.TOS_REGION || "cn-beijing", network);
  const { TosClient } = require(`${ROOT}/node_modules/@volcengine/tos-sdk`);
  return { bucket: env.TOS_BUCKET, client: new TosClient({ accessKeyId: env.TOS_ACCESS_KEY_ID, accessKeySecret: env.TOS_SECRET_ACCESS_KEY, region: env.TOS_REGION || "cn-beijing", endpoint, requestTimeout: 60000, maxRetryCount: 0 }) };
}
async function remote(stage, apply) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !/^\/var\/tmp\/silver-static-[a-f0-9]{40}-\d+$/.test(stage)) fail("Invalid remote static context");
  const value = validatePlan(JSON.parse(fs.readFileSync(`${stage}/plan.json`)));
  if (release.hash(fs.readFileSync(`${stage}/target.tar.gz`)) !== value.archiveHash || release.hash(fs.readFileSync(__filename)) !== value.executorHash || path.resolve(__filename) !== `${stage}/source/${EXECUTOR}`) fail("Static GitHub executor/archive mismatch");
  const lock = "/var/run/silver-static-release.lock"; fs.mkdirSync(lock, { mode: 0o700 });
  try {
    for (const file of ["server.js", ...fs.readdirSync(`${stage}/source/server`).filter(f => /^[a-zA-Z0-9_-]+\.js$/.test(f)).map(f => `server/${f}`)]) {
      if (release.hash(fs.readFileSync(`${stage}/source/${file}`)) !== release.hash(fs.readFileSync(`${ROOT}/${file}`))) fail(`Backend code not at target GitHub source: ${file}`);
    }
    const t = liveTos(value.network), backup = `/var/backups/silver-static-${Date.now()}-${value.target.slice(0, 12)}`;
    if (apply) { const disk = fs.statfsSync("/var/backups"); if (Number(disk.bavail) * Number(disk.bsize) < 64 * 1024 ** 2 + value.files.reduce((sum, f) => sum + f.size, 0) * 2) fail("Insufficient static backup disk space"); }
    console.log(JSON.stringify(await publish(t.client, t.bucket, value, `${stage}/source`, backup, apply)));
  } finally { fs.rmdirSync(lock); }
}
async function local(args) {
  const o = options(args);
  if (run("git", ["status", "--porcelain"]).toString().trim()) fail("Static release requires clean committed checkout");
  if (!/^(https:\/\/github\.com\/|git@github\.com:)xuepengjun2-cell\/silver-community-h5(?:\.git)?$/.test(run("git", ["remote", "get-url", "origin"]).toString().trim())) fail("Wrong static repository");
  const target = release.sha(api("commits/main").sha);
  if (o.sha && o.sha !== target || run("git", ["rev-parse", "HEAD"]).toString().trim() !== target) fail("Static HEAD/requested SHA must equal pushed main");
  const ci = release.validateCi(api(`actions/runs?head_sha=${target}&event=push&per_page=100`), target);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "silver-static-github-")); fs.chmodSync(directory, 0o700);
  try {
    for (const [name, commit] of [["base", o.base], ["target", target]]) {
      const archive = `${directory}/${name}.tar.gz`, dest = `${directory}/${name}`;
      fs.writeFileSync(archive, run("gh", ["api", `repos/${REPO}/tarball/${commit}`]), { mode: 0o600 });
      release.archiveNames(run("tar", ["-tzf", archive]).toString());
      if (run("tar", ["-tvzf", archive]).toString().trim().split("\n").some(line => !["-", "d"].includes(line[0]))) fail("Static archive links forbidden");
      fs.mkdirSync(dest, { mode: 0o700 }); run("tar", ["-xzf", archive, "--strip-components=1", "-C", dest]);
    }
    if (release.hash(fs.readFileSync(__filename)) !== release.hash(fs.readFileSync(`${directory}/target/${EXECUTOR}`))) fail("Local static executor not from target GitHub SHA");
    const value = plan(`${directory}/base`, `${directory}/target`, target, o.base, ci, release.hash(fs.readFileSync(`${directory}/target.tar.gz`)), o.network);
    fs.writeFileSync(`${directory}/plan.json`, JSON.stringify(value), { mode: 0o600 });
    if (api("commits/main").sha !== target) fail("GitHub main moved before static dispatch");
    release.validateCi(api(`actions/runs?head_sha=${target}&event=push&per_page=100`), target);
    const stage = `/var/tmp/silver-static-${target}-${Date.now()}`, connection = release.identityOptions(), ssh = [...connection, HOST];
    run("ssh", [...ssh, `umask 077; mkdir -m700 ${stage}`]);
    run("scp", ["-q", ...connection, `${directory}/target.tar.gz`, `${directory}/plan.json`, `${HOST}:${stage}/`]);
    try { run("ssh", [...ssh, `umask 077; mkdir -m700 ${stage}/source && tar -xzf ${stage}/target.tar.gz --strip-components=1 -C ${stage}/source && node ${stage}/source/${EXECUTOR} --remote ${stage}${o.apply ? " --apply" : ""}`], { timeout: 10 * 60 * 1000, stdio: ["ignore", "inherit", "pipe"] }); }
    catch (error) {
      for (const line of String(error.stderr || "").trim().split("\n").reverse()) { let result; try { result = JSON.parse(line); } catch { continue; } if (result?.ok === false && typeof result.error === "string" && result.error.length < 3000) fail(result.error); }
      fail("Static remote command failed; inspect retained staging/backup before retry");
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
async function main(args) { if (args[0] === "--remote" && (args.length === 2 || args.length === 3 && args[2] === "--apply")) return remote(args[1], args[2] === "--apply"); return local(args); }
module.exports = { options, key, plan, validatePlan, assertOrigin, metadata, versionedScripts, publish, FILES, OBJECTS, LEGACY };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof StaticError ? error.message : "Static release failed; raw errors/credentials withheld" })); process.exitCode = 1; });
