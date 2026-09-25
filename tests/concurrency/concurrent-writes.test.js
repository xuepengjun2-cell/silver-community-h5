// 并发写入回归测试：用内存版 MySQL 和延迟上传的假 TOS 启动真实 server.js，
// 在上传、转码、合并分片的等待期间插入新建/删除/排序/编辑请求，确认不会覆盖或丢失其他相册、案例。
// 运行：npm run test:concurrency（每个场景单独启动一次服务，约 30 秒）。
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

async function boot({ seed = {}, tosDelay = 0, headDelay = 0 } = {}) {
  const dir = prepareCopy();
  const seedFile = path.join(dir, "seed.json");
  const dumpFile = path.join(dir, "dump.json");
  fs.writeFileSync(seedFile, JSON.stringify(seed));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "preload.js"), "server.js"], {
    cwd: dir,
    env: {
      ...process.env, PORT: String(port), FAKE_DB_SEED: seedFile, FAKE_DB_DUMP: dumpFile,
      FAKE_TOS_DIR: path.join(dir, "tos"), FAKE_TOS_DELAY_MS: String(tosDelay), FAKE_TOS_HEAD_DELAY_MS: String(headDelay),
      TOS_SDK_PATH: path.join(__dirname, "fake-tos.js"), TOS_ACCESS_KEY_ID: "x", TOS_SECRET_ACCESS_KEY: "x",
      TOS_BUCKET: "bucket", TOS_ENDPOINT: "tos.local", CASE_DIRECT_SYNC_TOKEN: SYNC_TOKEN
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

const createAlbum = async (ctx, token, title) => (await ctx.api("/my/activity-projects", { method: "POST", token, body: { title } })).data.project.id;
const listAlbums = async (ctx, token) => (await ctx.api("/my/activity-projects", { token })).data.projects;
const photoForm = name => {
  const form = new FormData();
  form.append("media", new Blob([crypto.randomBytes(4096)]), name);
  return form;
};

function assertAlbumsIntact(ctx, albums, titles, withMedia) {
  assert.deepEqual(albums.map(p => p.title).sort(), [...titles].sort(), "每个相册恰好出现一次");
  assert.equal(albums.find(p => p.title === withMedia).media.length, 1);
  assert.equal((ctx.persisted().activity_projects || []).length, titles.length, "数据库里没有相册被删掉");
}

test("H5 上传照片期间新建相册，不覆盖其他相册", () => withServer({ tosDelay: 800 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  await createAlbum(ctx, token, "B");
  const upload = ctx.api(`/my/activity-projects/${a}/media?type=image&ext=jpg&title=photo`, { method: "POST", token, raw: crypto.randomBytes(4096) });
  await sleep(250);
  await createAlbum(ctx, token, "C");
  assert.equal((await upload).status, 201);
  assertAlbumsIntact(ctx, await listAlbums(ctx, token), ["A", "B", "C"], "A");
}));

test("H5 上传期间管理员打开相册列表（排序），不写错相册", () => withServer({ tosDelay: 800 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  const b = await createAlbum(ctx, token, "B");
  await sleep(20);
  await ctx.api(`/my/activity-projects/${a}`, { method: "PATCH", token, body: { title: "A" } });
  const upload = ctx.api(`/my/activity-projects/${b}/media?type=image&ext=jpg&title=photo`, { method: "POST", token, raw: crypto.randomBytes(4096) });
  await sleep(250);
  await ctx.api("/admin/activity-projects", { token });
  assert.equal((await upload).status, 201);
  assertAlbumsIntact(ctx, await listAlbums(ctx, token), ["A", "B"], "B");
}));

test("上传期间关闭分享，上传完成后仍保持关闭", () => withServer({ tosDelay: 800 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  const upload = ctx.api(`/my/activity-projects/${a}/media?type=image&ext=jpg&title=photo`, { method: "POST", token, raw: crypto.randomBytes(4096) });
  await sleep(250);
  await ctx.api(`/my/activity-projects/${a}`, { method: "PATCH", token, body: { shareEnabled: false } });
  assert.equal((await upload).status, 201);
  const [album] = await listAlbums(ctx, token);
  assert.equal(album.shareEnabled, false);
  assert.equal(album.media.length, 1);
  assert.equal((await ctx.api(`/public/activity-projects/${a}`)).status, 404);
}));

test("小程序上传照片期间新建相册，不覆盖其他相册", () => withServer({ tosDelay: 800 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  await createAlbum(ctx, token, "B");
  const upload = ctx.api(`/my/activity-projects/${a}/miniapp-media?type=image`, { method: "POST", token, raw: photoForm("photo.jpg") });
  await sleep(250);
  await createAlbum(ctx, token, "C");
  assert.equal((await upload).status, 201);
  assertAlbumsIntact(ctx, await listAlbums(ctx, token), ["A", "B", "C"], "A");
}));

test("小程序视频队列发布期间新建相册，不覆盖其他相册", () => withServer({ tosDelay: 700 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  await createAlbum(ctx, token, "B");
  const queued = await ctx.api(`/my/activity-projects/${a}/miniapp-media?type=video`, { method: "POST", token, raw: photoForm("clip.mp4") });
  await sleep(300);
  await createAlbum(ctx, token, "C");
  let job = {};
  for (let i = 0; i < 60 && !["ready", "failed"].includes(job.status); i++) {
    await sleep(100);
    job = (await ctx.api(`/my/activity-projects/${a}/miniapp-media/${queued.data.jobId}`, { token })).data;
  }
  assert.equal(job.status, "ready");
  assertAlbumsIntact(ctx, await listAlbums(ctx, token), ["A", "B", "C"], "A");
}));

test("H5 大视频后台生成 MP4 期间新建相册，不覆盖其他相册", () => withServer({ tosDelay: 700 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  await createAlbum(ctx, token, "B");
  const body = crypto.randomBytes(64 * 1024);
  const init = await ctx.api(`/my/activity-projects/${a}/media/init`, { method: "POST", token, body: { type: "video", ext: "mov", size: body.length, title: "clip" } });
  const session = ctx.persisted().project_upload_sessions.find(row => row.id === init.data.sessionId);
  fs.mkdirSync(path.join(ctx.dir, "tos"), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, "tos", encodeURIComponent(session.object_key)), body);
  assert.equal((await ctx.api(`/my/activity-projects/${a}/media/upload-session/${init.data.sessionId}/complete?delivery=1`, { method: "POST", token, body: {} })).status, 202);
  await sleep(300);
  await createAlbum(ctx, token, "C");
  let status = {};
  for (let i = 0; i < 80 && !["completed", "delivery_failed"].includes(status.status); i++) {
    await sleep(100);
    status = (await ctx.api(`/my/activity-projects/${a}/media/upload-session/${init.data.sessionId}/status`, { token })).data;
  }
  assert.equal(status.status, "completed", status.error);
  assertAlbumsIntact(ctx, await listAlbums(ctx, token), ["A", "B", "C"], "A");
}));

test("相册在上传期间被删除：返回 404 并清掉刚上传的对象", () => withServer({ tosDelay: 600 }, async ctx => {
  const token = await ctx.login();
  const a = await createAlbum(ctx, token, "A");
  const b = await createAlbum(ctx, token, "B");
  const h5 = ctx.api(`/my/activity-projects/${a}/media?type=image&ext=jpg&title=photo`, { method: "POST", token, raw: crypto.randomBytes(4096) });
  const mini = ctx.api(`/my/activity-projects/${b}/miniapp-media?type=image`, { method: "POST", token, raw: photoForm("photo.jpg") });
  await sleep(250);
  await ctx.api(`/my/activity-projects/${a}`, { method: "DELETE", token });
  await ctx.api(`/my/activity-projects/${b}`, { method: "DELETE", token });
  const [h5Result, miniResult] = await Promise.all([h5, mini]);
  assert.equal(h5Result.status, 404);
  assert.equal(miniResult.status, 404);
  const tosDir = path.join(ctx.dir, "tos");
  assert.deepEqual(fs.existsSync(tosDir) ? fs.readdirSync(tosDir) : [], []);
}));

test("视频号采集器直传登记期间删除其他案例，不覆盖相邻案例", async () => {
  const doc = (id, title) => ({ id, status: "published", category: "", sort_order: 1, created_at: "2026-09-01T00:00:00.000Z",
    doc: JSON.stringify({ id, title, status: "published", media: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }) });
  await withServer({ headDelay: 600, seed: { cases: [doc("case_1111111111111111", "X"), doc(CASE_T, "T"), doc("case_2222222222222222", "Y")] } }, async ctx => {
    const token = await ctx.login();
    const body = crypto.randomBytes(160 * 1024);
    const auth = { Authorization: `Bearer ${SYNC_TOKEN}` };
    const init = await ctx.api(`/automation/cases/${CASE_T}/videos/init`, { method: "POST", headers: auth,
      body: { sourceVideoId: "1234567890", sourceSha256: crypto.createHash("sha256").update(body).digest("hex"), ext: "mp4", size: body.length, title: "clip" } });
    const session = ctx.persisted().case_direct_upload_sessions.find(row => row.id === init.data.sessionId);
    fs.mkdirSync(path.join(ctx.dir, "tos"), { recursive: true });
    fs.writeFileSync(path.join(ctx.dir, "tos", encodeURIComponent(session.object_key)), body);
    const complete = ctx.api(`/automation/cases/${CASE_T}/videos/upload-session/${init.data.sessionId}/complete`, { method: "POST", headers: auth, body: {} });
    await sleep(200);
    await ctx.api("/admin/cases/case_1111111111111111", { method: "DELETE", token });
    assert.equal((await complete).status, 201);
    const cases = (await ctx.api("/admin/cases", { token })).data.cases;
    assert.deepEqual(cases.map(c => c.title).sort(), ["T", "Y"]);
    assert.equal(cases.find(c => c.title === "T").media.length, 1);
    assert.equal(ctx.persisted().cases.length, 2);
  });
});

test("多人同时登录都成功，过期登录态被清理", async () => {
  const expired = { token: "expired-token", user_id: "u_admin", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-08T00:00:00.000Z" };
  await withServer({ seed: { sessions: [expired] } }, async ctx => {
    await ctx.login();
    const results = await Promise.all(Array.from({ length: 12 }, () => ctx.api("/login", { method: "POST", body: { username: "admin", password: "admin123" } })));
    assert.deepEqual(results.map(r => r.status), Array(12).fill(200));
    await sleep(300);
    const rows = ctx.persisted().sessions;
    assert.equal(rows.some(r => r.token === "expired-token"), false);
    for (const { data } of results) assert.ok(rows.some(r => r.token === data.token));
    assert.ok((await ctx.api("/me", { token: results[0].data.token })).data.user);
  });
});
