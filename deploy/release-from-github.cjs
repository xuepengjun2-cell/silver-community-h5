#!/usr/bin/env node
"use strict";
// GitHub-first, code-only release. Never restores or writes business database rows.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const REPO = "xuepengjun2-cell/silver-community-h5";
const ROOT = "/var/www/silver-community-h5";
const HOST = "root@115.190.225.47";
const TABLES = ["users", "activities", "posts", "cases", "activity_projects"];
const EXECUTOR = "deploy/release-from-github.cjs";
class ReleaseError extends Error {}
const fail = message => { throw new ReleaseError(message); };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);
const sha = value => { if (!/^[a-f0-9]{40}$/.test(value || "")) fail("Expected exact lowercase 40-character GitHub SHA"); return value; };
const allowed = file => file === "server.js" || /^server\/[a-zA-Z0-9_-]+\.js$/.test(file) || ["public/app.js", "public/admin.js", "public/styles.css", "public/app.css", "public/admin.css", "public/index.html", "public/admin.html", "package.json"].includes(file);
function identityOptions(env = process.env) {
  const identity = env.SILVER_DEPLOY_IDENTITY ?? "/Users/a1234/.ssh/kkhc_hq_deploy_ed25519";
  if (typeof identity !== "string" || !path.isAbsolute(identity) || path.resolve(identity) !== identity || /[\x00-\x1f]/.test(identity)) fail("SILVER_DEPLOY_IDENTITY must be an absolute normalized path");
  return ["-i", identity, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
}
function assertCodeHash(file, actual, expected, context) {
  if (!allowed(file) && file !== "package-lock.json") fail("Invalid code hash path");
  if (actual !== expected) fail(`${context}: ${file}; expected=${expected ?? "absent"}; actual=${actual ?? "absent"}`);
}
function options(args) {
  const out = { apply: false };
  for (const arg of args) {
    if (arg === "--apply" && !out.apply) out.apply = true;
    else if (/^--(sha|base)=[a-f0-9]{40}$/.test(arg)) {
      const [key, value] = arg.slice(2).split("="); if (out[key]) fail("Duplicate option"); out[key] = sha(value);
    } else fail("Use --base=<40SHA> [--sha=<main40SHA>] [--apply]; default is dry-run");
  }
  if (!out.base) fail("Explicit reviewed production --base=<40SHA> required");
  return out;
}
function run(command, args, extra = {}) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 ** 2, timeout: 120000, ...extra });
}
const json = (command, args) => JSON.parse(run(command, args).toString());
function validateCi(response, target) {
  sha(target);
  const runs = (response.workflow_runs || []).filter(r => r.name === "Check" && r.path === ".github/workflows/check.yml" && r.head_sha === target && r.head_branch === "main" && r.event === "push").sort((a, b) => b.id - a.id);
  const latest = runs[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") fail("Latest main Check workflow must succeed for exact target SHA");
  return { id: latest.id, head_sha: target, conclusion: latest.conclusion, html_url: latest.html_url };
}
function archiveNames(listing) {
  const names = listing.trim().split("\n");
  const top = names[0]?.split("/")[0];
  if (!top || !/^[a-zA-Z0-9_.-]+$/.test(top)) fail("Unsafe GitHub archive root");
  for (const name of names) if (!name.startsWith(`${top}/`) || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => part === ".." || part === ".")) fail("Unsafe GitHub archive path");
  return top;
}
function extract(archive, directory) {
  archiveNames(run("tar", ["-tzf", archive]).toString());
  const types = run("tar", ["-tvzf", archive]).toString().trim().split("\n");
  if (types.some(line => !["-", "d"].includes(line[0]))) fail("Archive links and special files forbidden");
  fs.mkdirSync(directory, { mode: 0o700 });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
}
function codeFiles(directory) {
  const list = ["server.js", "package.json", ...fs.readdirSync(`${directory}/server`).map(f => `server/${f}`), ...fs.readdirSync(`${directory}/public`).map(f => `public/${f}`)].filter(allowed).sort();
  for (const name of list) if (!fs.lstatSync(`${directory}/${name}`).isFile()) fail("Release files must be regular files");
  return list;
}
function assertPackages(before, after) {
  const clean = value => { const result = { ...value }; delete result.version; delete result.scripts; return result; };
  if (stable(clean(before)) !== stable(clean(after))) fail("Dependency or package configuration changes require a separate deployment");
}
function functionText(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
  if (!match) fail(`Startup function missing: ${name}`);
  const end = source.indexOf("\n}", match.index);
  if (end < 0) fail("Unrecognized startup function structure");
  return source.slice(match.index, end + 2);
}
function assertStartup(rows, source, env = {}) {
  const constants = ["VALID_PROJECT_STATUSES", "VALID_PROJECT_MEDIA_TYPES"].map(name => {
    const match = source.match(new RegExp(`const ${name} = (\\[[^\\n]+\\]);`));
    if (!match) fail("Unrecognized startup constants"); return `const ${name} = ${match[1]};`;
  }).join("\n");
  const script = `${constants}\n${["cleanString", "normalizeProjectMedia", "normalizeActivityProject"].map(name => functionText(source, name)).join("\n")}\nrows.map(p => normalizeActivityProject(p, p));`;
  const docs = rows.map(row => typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc);
  const output = new vm.Script(script).runInNewContext({ rows: JSON.parse(JSON.stringify(docs)), now: () => fail("Startup would add timestamp"), createId: () => fail("Startup would add identifier"), PROJECT_IMAGE_PUBLIC_BASE: env.PROJECT_IMAGE_PUBLIC_BASE || "https://proj2.likeduoduiyi.cn/silver-project-images" }, { timeout: 1000 });
  if (stable(output) !== stable(docs)) fail("Startup would normalize existing project data; release refused");
}
function plan(before, after, target, base, ci, archiveHash) {
  sha(target); sha(base);
  assertPackages(JSON.parse(fs.readFileSync(`${before}/package.json`)), JSON.parse(fs.readFileSync(`${after}/package.json`)));
  if (hash(fs.readFileSync(`${before}/package-lock.json`)) !== hash(fs.readFileSync(`${after}/package-lock.json`))) fail("package-lock changes forbidden");
  if (functionText(fs.readFileSync(`${before}/server.js`, "utf8"), "initDb") !== functionText(fs.readFileSync(`${after}/server.js`, "utf8"), "initDb")) fail("Startup/schema changes require a separate reviewed release");
  const oldFiles = codeFiles(before), files = codeFiles(after);
  if (oldFiles.some(file => !files.includes(file))) fail("Runtime file deletion forbidden");
  return { version: 1, target, base, ci, archiveHash, executorHash: hash(fs.readFileSync(`${after}/${EXECUTOR}`)), lockHash: hash(fs.readFileSync(`${after}/package-lock.json`)), files: files.map(file => ({ file, before: oldFiles.includes(file) ? hash(fs.readFileSync(`${before}/${file}`)) : null, after: hash(fs.readFileSync(`${after}/${file}`)) })) };
}
function validatePlan(value) {
  if (!value || value.version !== 1) fail("Invalid release plan"); sha(value.target); sha(value.base);
  if (value.ci?.head_sha !== value.target || value.ci?.conclusion !== "success") fail("CI evidence mismatch");
  for (const field of ["archiveHash", "executorHash", "lockHash"]) if (!/^[a-f0-9]{64}$/.test(value[field] || "")) fail("Invalid artifact hash");
  if (!Array.isArray(value.files) || !value.files.length || !value.files.some(f => f.file === "server.js") || !value.files.some(f => f.file === "package.json")) fail("Incomplete release plan");
  const seen = new Set();
  for (const item of value.files) {
    if (typeof item.file !== "string" || !allowed(item.file) || seen.has(item.file) || !/^[a-f0-9]{64}$/.test(item.after || "") || item.before !== null && !/^[a-f0-9]{64}$/.test(item.before || "")) fail("Unsafe release file"); seen.add(item.file);
  }
  return value;
}
function runtime() {
  const matches = json("pm2", ["jlist"]).filter(p => p.name === "silver");
  if (matches.length !== 1) fail("Expected one silver process");
  const p = matches[0], e = p.pm2_env;
  if (e.pm_cwd !== ROOT || e.pm_exec_path !== `${ROOT}/server.js` || e.exec_mode !== "fork_mode" || Number(e.instances || 1) !== 1) fail("Unexpected PM2 runtime definition");
  return p;
}
function assertStopped(oldPid) {
  const p = runtime();
  if (p.pid || p.pm2_env.status !== "stopped" || fs.existsSync(`/proc/${oldPid}`)) fail("Old runtime not fully stopped");
  for (const pid of fs.readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
    try { if (fs.readlinkSync(`/proc/${pid}/cwd`) === ROOT && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").some(a => a === "server.js" || a === `${ROOT}/server.js`)) fail("Another runtime process remains"); }
    catch (error) { if (error instanceof ReleaseError) throw error; }
  }
}
async function snapshot(conn) {
  await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  try {
    const output = {};
    for (const table of TABLES) { const [rows] = await conn.query(`SELECT * FROM \`${table}\` ORDER BY id`); output[table] = rows.map(r => ({ ...r, doc: typeof r.doc === "string" ? JSON.parse(r.doc) : r.doc })); }
    if (!output.users.length) fail("Refuse empty users database");
    await conn.commit(); return output;
  } catch (error) { await conn.rollback(); throw error; }
}
const sameData = (before, after) => { if (stable(before) !== stable(after)) fail("Business table data changed; code rollback only, database never overwritten"); };
async function idle(conn) {
  for (const table of ["project_upload_sessions", "case_direct_upload_sessions"]) {
    const [[row]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table} WHERE status IN ('uploading','receiving','queued','processing')`);
    if (Number(row.n)) fail("Active upload session; retry after completion");
  }
  const file = `${ROOT}/data/miniapp-video-jobs.json`;
  if (fs.existsSync(file)) { const jobs = JSON.parse(fs.readFileSync(file)); if (!Array.isArray(jobs) || jobs.some(j => ["receiving", "queued", "processing"].includes(j.status))) fail("Active media job; retry after completion"); }
}
async function healthy() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      for (const url of ["http://127.0.0.1:5174/api/health", "https://apip2.opensplendid.com/silver-api/health"]) {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw Error();
        const body = await response.json(); if (body.ok !== true || body.service !== "silver" || body.database !== "ok") throw Error();
      }
      if (runtime().pm2_env.status !== "online") throw Error(); return;
    } catch { if (attempt === 19) fail("Health JSON verification failed"); await new Promise(resolve => setTimeout(resolve, 500)); }
  }
}
function atomicCopy(source, target, mode = 0o644) {
  const temporary = `${target}.silver-release-${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(temporary, mode); const fd = fs.openSync(temporary, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function fileHash(file) { if (!fs.existsSync(file)) return null; if (!fs.lstatSync(file).isFile()) fail("Runtime links/special files forbidden"); return hash(fs.readFileSync(file)); }
async function remote(stage, apply = false) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !/^\/var\/tmp\/silver-release-[a-f0-9]{40}-\d+$/.test(stage)) fail("Invalid remote execution context");
  const manifest = validatePlan(JSON.parse(fs.readFileSync(`${stage}/plan.json`)));
  if (hash(fs.readFileSync(`${stage}/target.tar.gz`)) !== manifest.archiveHash || hash(fs.readFileSync(__filename)) !== manifest.executorHash) fail("GitHub archive/executor mismatch");
  const source = `${stage}/source`;
  if (path.resolve(__filename) !== `${source}/${EXECUTOR}`) fail("Execute only GitHub archive release tool");
  if (fs.existsSync(`${ROOT}/.git`) || fs.realpathSync(ROOT) !== ROOT) fail("Unexpected runtime root");
  for (const item of manifest.files) {
    if (item.file === "package.json" && fileHash(`${ROOT}/${item.file}`) !== item.before) {
      assertPackages(JSON.parse(fs.readFileSync(`${ROOT}/package.json`)), JSON.parse(fs.readFileSync(`${source}/package.json`)));
      item.before = fileHash(`${ROOT}/${item.file}`); // Bind known version/test-script drift for exact rollback.
    }
    assertCodeHash(item.file, fileHash(`${source}/${item.file}`), item.after, "GitHub source mismatch");
    assertCodeHash(item.file, fileHash(`${ROOT}/${item.file}`), item.before, "Runtime baseline mismatch");
    if (fs.realpathSync(path.dirname(`${ROOT}/${item.file}`)) !== path.dirname(`${ROOT}/${item.file}`)) fail("Runtime parent symlink forbidden");
    if (item.file.endsWith(".js")) run("node", ["--check", `${source}/${item.file}`]);
  }
  assertCodeHash("package-lock.json", fileHash(`${ROOT}/package-lock.json`), manifest.lockHash, "Installed dependency lock drift");
  assertPackages(JSON.parse(fs.readFileSync(`${ROOT}/package.json`)), JSON.parse(fs.readFileSync(`${source}/package.json`)));
  run("ffmpeg", ["-version"]); run("ffprobe", ["-version"]);
  const disk = fs.statfsSync(ROOT); if (Number(disk.bavail) * Number(disk.bsize) <= 1024 ** 3 + fs.statSync(`${stage}/target.tar.gz`).size * 3) fail("Insufficient release disk space");
  const processInfo = runtime(); if (processInfo.pm2_env.status !== "online" || !processInfo.pid) fail("Original runtime must be healthy and online");
  const env = {}; for (const field of fs.readFileSync(`/proc/${processInfo.pid}/environ`, "utf8").split("\0")) { const i = field.indexOf("="); if (i > 0) env[field.slice(0, i)] = field.slice(i + 1); }
  if (Number(env.PORT || 5174) !== 5174) fail("Unexpected port");
  const conn = await require(`${ROOT}/node_modules/mysql2/promise`).createConnection({ host: env.DB_HOST || "127.0.0.1", port: Number(env.DB_PORT || 3306), user: env.DB_USER || "silver", password: env.DB_PASS || "", database: env.DB_NAME || "silver", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const lock = "/var/run/silver-release.lock", installed = []; let locked = false, stopped = false, backedUp = false, backup;
  try {
    fs.mkdirSync(lock, { mode: 0o700 }); locked = true;
    await healthy(); await idle(conn);
    const [engines] = await conn.query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    if (TABLES.some(table => !engines.some(row => row.TABLE_NAME === table && row.ENGINE === "InnoDB"))) fail("Business tables must exist and use InnoDB");
    const before = await snapshot(conn); assertStartup(before.activity_projects, fs.readFileSync(`${source}/server.js`, "utf8"), env);
    if (!apply) { console.log(JSON.stringify({ ok: true, dryRun: true, target: manifest.target, businessHash: hash(stable(before)), files: manifest.files })); return; }
    backup = `/var/backups/silver-release-${Date.now()}-${manifest.target.slice(0, 12)}`; fs.mkdirSync(backup, { mode: 0o700 });
    fs.writeFileSync(`${backup}/business-before.json`, JSON.stringify(before), { mode: 0o600, flag: "wx" });
    fs.writeFileSync(`${backup}/plan.json`, JSON.stringify({ ...manifest, businessBeforeHash: hash(stable(before)) }), { mode: 0o600, flag: "wx" });
    for (const item of manifest.files) if (item.before !== null) { const dest = `${backup}/${item.file}`; fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.copyFileSync(`${ROOT}/${item.file}`, dest); fs.chmodSync(dest, 0o600); }
    backedUp = true;
    // Mark first: even a failed stop command may have stopped the original process.
    stopped = true; run("pm2", ["stop", "silver"]); assertStopped(processInfo.pid);
    await idle(conn); sameData(before, await snapshot(conn));
    for (const item of manifest.files) { assertCodeHash(item.file, fileHash(`${ROOT}/${item.file}`), item.before, "Runtime changed before install"); installed.push(item); atomicCopy(`${source}/${item.file}`, `${ROOT}/${item.file}`); }
    run("pm2", ["start", "silver"]); await healthy();
    for (const item of manifest.files) assertCodeHash(item.file, fileHash(`${ROOT}/${item.file}`), item.after, "Installed code readback mismatch");
    const after = await snapshot(conn); sameData(before, after);
    fs.writeFileSync(`${backup}/verified.json`, JSON.stringify({ target: manifest.target, businessHash: hash(stable(after)), code: manifest.files, databaseRestored: false }), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ok: true, target: manifest.target, backup, businessHash: hash(stable(after)), databaseRestored: false }));
  } catch (error) {
    if (stopped && backedUp) {
      try {
        const rollbackPid = runtime().pid; run("pm2", ["stop", "silver"]); assertStopped(rollbackPid || processInfo.pid);
        for (const item of [...installed].reverse()) { if (item.before === null) { if (fs.existsSync(`${ROOT}/${item.file}`)) fs.unlinkSync(`${ROOT}/${item.file}`); } else atomicCopy(`${backup}/${item.file}`, `${ROOT}/${item.file}`); }
        run("pm2", ["start", "silver"]); await healthy();
        for (const item of manifest.files) assertCodeHash(item.file, fileHash(`${ROOT}/${item.file}`), item.before, "Rollback code readback failed");
        const currentData = await snapshot(conn);
        fs.writeFileSync(`${backup}/business-after-rollback.json`, JSON.stringify(currentData), { mode: 0o600, flag: "wx" });
      } catch { fail(`Release failed; code/process rollback needs operator attention; backup=${backup}; database never restored`); }
      fail(`Release failed; code rolled back and original process restored; backup=${backup}; database never restored`);
    }
    throw error;
  } finally { await conn.end(); if (locked) fs.rmdirSync(lock); }
}
async function local(args) {
  const o = options(args);
  if (run("git", ["status", "--porcelain"]).toString().trim()) fail("Dirty checkout forbidden; commit and push reviewed changes first");
  if (!/^(https:\/\/github\.com\/|git@github\.com:)xuepengjun2-cell\/silver-community-h5(?:\.git)?$/.test(run("git", ["remote", "get-url", "origin"]).toString().trim())) fail("Wrong GitHub repository");
  const target = sha(json("gh", ["api", `repos/${REPO}/commits/main`]).sha);
  if (o.sha && o.sha !== target || run("git", ["rev-parse", "HEAD"]).toString().trim() !== target) fail("HEAD and requested SHA must equal pushed GitHub main");
  const ci = validateCi(json("gh", ["api", `repos/${REPO}/actions/runs?head_sha=${target}&event=push&per_page=100`]), target);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "silver-github-release-")); fs.chmodSync(directory, 0o700);
  try {
    for (const [name, commit] of [["base", o.base], ["target", target]]) {
      fs.writeFileSync(`${directory}/${name}.tar.gz`, run("gh", ["api", `repos/${REPO}/tarball/${commit}`]), { mode: 0o600 }); extract(`${directory}/${name}.tar.gz`, `${directory}/${name}`);
    }
    if (hash(fs.readFileSync(__filename)) !== hash(fs.readFileSync(`${directory}/target/${EXECUTOR}`))) fail("Local executor differs from reviewed GitHub SHA");
    const manifest = plan(`${directory}/base`, `${directory}/target`, target, o.base, ci, hash(fs.readFileSync(`${directory}/target.tar.gz`))); validatePlan(manifest);
    fs.writeFileSync(`${directory}/plan.json`, JSON.stringify(manifest), { mode: 0o600 });
    console.log(JSON.stringify({ dryRun: !o.apply, target, base: o.base, ci, files: manifest.files, note: "No private keys or environment files uploaded; business database is never restored" }));
    // Recheck GitHub immediately before dispatch; do not publish superseded main.
    if (json("gh", ["api", `repos/${REPO}/commits/main`]).sha !== target) fail("GitHub main moved during preparation");
    validateCi(json("gh", ["api", `repos/${REPO}/actions/runs?head_sha=${target}&event=push&per_page=100`]), target);
    const stage = `/var/tmp/silver-release-${target}-${Date.now()}`, connection = identityOptions(), ssh = [...connection, HOST];
    run("ssh", [...ssh, `umask 077; mkdir -m 700 ${stage}`]);
    run("scp", ["-q", ...connection, `${directory}/target.tar.gz`, `${directory}/plan.json`, `${HOST}:${stage}/`]);
    // Only the executor from the exact GitHub tarball is run remotely.
    try {
      run("ssh", [...ssh, `umask 077; mkdir -m 700 ${stage}/source && tar -xzf ${stage}/target.tar.gz --strip-components=1 -C ${stage}/source && node ${stage}/source/${EXECUTOR} --remote ${stage}${o.apply ? " --apply" : ""}`], { timeout: 10 * 60 * 1000, stdio: ["ignore", "inherit", "pipe"] });
    } catch (error) {
      const lines = String(error.stderr || "").trim().split("\n");
      for (const line of lines.reverse()) {
        let result; try { result = JSON.parse(line); } catch { continue; }
        if (result?.ok === false && typeof result.error === "string" && result.error.length < 2000) fail(`Remote release rejected: ${result.error}`);
      }
      fail("Remote release connection/command failed; inspect retained staging and release backup before retry");
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
async function main(args) { if (args[0] === "--remote" && (args.length === 2 || args.length === 3 && args[2] === "--apply")) return remote(args[1], args[2] === "--apply"); return local(args); }
module.exports = { sha, options, identityOptions, assertCodeHash, allowed, validateCi, archiveNames, assertPackages, functionText, assertStartup, plan, validatePlan, stable, hash, sameData, atomicCopy };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof ReleaseError ? error.message : "Release command failed; raw output withheld to protect credentials" })); process.exitCode = 1; });
