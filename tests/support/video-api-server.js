const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CASE_T = "case_ead7a3aa8b0aa2d9";
const SYNC_TOKEN = "t".repeat(40);

function prepareCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-concurrency-"));
  for (const entry of ["server.js", "server", "public", "package.json"]) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, "data"));
  fs.copyFileSync(path.join(ROOT, "data/seed-activities.json"), path.join(dir, "data/seed-activities.json"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

async function boot({ seed = {}, tosDelay = 0, headDelay = 0, env = {} } = {}) {
  const dir = prepareCopy();
  const seedFile = path.join(dir, "seed.json");
  const dumpFile = path.join(dir, "dump.json");
  fs.writeFileSync(seedFile, JSON.stringify(seed));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "../concurrency/preload.js"), "server.js"], {
    cwd: dir,
    env: {
      ...process.env, PORT: String(port), FAKE_DB_SEED: seedFile, FAKE_DB_DUMP: dumpFile,
      FAKE_TOS_DIR: path.join(dir, "tos"), FAKE_TOS_DELAY_MS: String(tosDelay), FAKE_TOS_HEAD_DELAY_MS: String(headDelay),
      TOS_SDK_PATH: path.join(__dirname, "../concurrency/fake-tos.js"), TOS_ACCESS_KEY_ID: "x", TOS_SECRET_ACCESS_KEY: "x",
      TOS_BUCKET: "bucket", TOS_ENDPOINT: "tos.local", CASE_DIRECT_SYNC_TOKEN: SYNC_TOKEN, ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  for (let i = 0; i < 100 && !log.includes("running at"); i++) await sleep(100);
  if (!log.includes("running at")) { child.kill(); throw new Error(`server did not start:\n${log}`); }
  const api = async (route, { method = "GET", token, body, raw, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: raw || (body ? JSON.stringify(body) : undefined)
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: response.status, data };
  };
  return {
    api, dir,
    login: async () => (await api("/login", { method: "POST", body: { username: "admin", password: "admin123" } })).data.token,
    persisted: () => JSON.parse(fs.readFileSync(dumpFile, "utf8")),
    stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

async function withServer(options, run) {
  const ctx = await boot(options);
  try { await run(ctx); } finally { ctx.stop(); }
}


module.exports = { boot, withServer, sleep, CASE_T, SYNC_TOKEN };
