const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withServer(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-wechat-test-"));
  let child;
  try {
    for (const entry of ["server.js", "server", "public", "package.json"]) {
      fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(path.join(ROOT, "data/seed-activities.json"), path.join(dir, "data/seed-activities.json"));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
    const salt = "test-only-salt";
    const admin = {
      id: "test_admin", username: "test-admin", name: "测试总部", role: "admin", status: "active",
      canDownload: true, salt, passwordHash: crypto.createHash("sha256").update(`${salt}:test-password`).digest("hex"),
      createdAt: new Date().toISOString()
    };
    const seed = path.join(dir, "seed.json");
    const activity = { id: "act_download_test", title: "下载权限测试活动", status: "published", downloadEnabled: true,
      city: "上海", category: "同城活动", createdAt: new Date().toISOString(), plan: { target: "测试" } };
    fs.writeFileSync(seed, JSON.stringify({ users: [{
      id: admin.id, username: admin.username, role: admin.role, status: admin.status,
      doc: JSON.stringify(admin), created_at: admin.createdAt
    }], activities: [{ id: activity.id, status: activity.status, city: activity.city, category: activity.category,
      sort_order: 1, created_at: activity.createdAt, doc: JSON.stringify(activity) }] }));
    const port = 21000 + Math.floor(Math.random() * 20000);
    const codes = { applicant1: "openid-first", applicant2: "openid-first", applicant3: "openid-first",
      applicant4: "openid-first", existing1: "openid-existing", existing2: "openid-existing",
      existing3: "openid-existing", existing4: "openid-existing",
      conflict: "openid-conflict" };
    child = spawn(process.execPath, ["--require", path.join(ROOT, "tests/concurrency/preload.js"), "server.js"], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), FAKE_DB_SEED: seed, FAKE_WECHAT_CODES: JSON.stringify(codes),
        WECHAT_MINIAPP_APPID: "wx-test", WECHAT_MINIAPP_SECRET: "test-only-secret" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    child.stdout.on("data", chunk => { log += chunk; });
    child.stderr.on("data", chunk => { log += chunk; });
    for (let i = 0; i < 100 && !log.includes("running at"); i++) await sleep(100);
    if (!log.includes("running at")) throw new Error(`server did not start: ${log}`);
    const api = async (route, { method = "GET", token, body } = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { text }; }
      return { status: response.status, data };
    };
    const logged = await api("/login", { method: "POST", body: { username: "test-admin", password: "test-password" } });
    assert.equal(logged.status, 200, log);
    await run({ api, adminToken: logged.data.token });
  } finally {
    if (child) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("新微信只能申请，管理员确认新建后才拿到同一平台 userId", () => withServer(async ({ api, adminToken }) => {
  const apply = await api("/auth/wechat/apply", { method: "POST", body: {
    code: "applicant1", name: "上海主理人", contact: "13800000000", city: "上海", organization: "银发俱乐部"
  } });
  assert.equal(apply.status, 201);
  assert.equal(apply.data.status, "pending");
  assert.deepEqual((await api("/auth/wechat/session", { method: "POST", body: { code: "applicant2" } })).data, { status: "pending" });
  assert.equal((await api("/my/activity-projects")).status, 401, "未审批者不能进入业务数据接口");
  assert.equal((await api("/admin/wechat/applications")).status, 401, "申请名单仅总部可见");
  const list = await api("/admin/wechat/applications", { token: adminToken });
  assert.equal(list.status, 200);
  const application = list.data.applications[0];
  assert.equal(application.openid, undefined, "不向后台页面泄露完整 OpenID");
  const blocked = await api(`/admin/wechat/applications/${application.id}/approve`, { method: "POST", token: adminToken, body: {} });
  assert.equal(blocked.status, 400);
  const approved = await api(`/admin/wechat/applications/${application.id}/approve`, { method: "POST", token: adminToken,
    body: { confirmNoExistingAccount: true, role: "operator", canDownload: true } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.user.role, "operator");
  const login = await api("/auth/wechat/session", { method: "POST", body: { code: "applicant3" } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, approved.data.user.id);
  assert.equal(login.data.loginMethod, "wechat-miniapp");
  const album = await api("/my/activity-projects", { method: "POST", token: login.data.token, body: { title: "同一账号的相册" } });
  assert.equal(album.status, 201);
  assert.equal(album.data.project.canManage, true);
  const passwordLogin = await api("/login", { method: "POST", body: { username: approved.data.user.username, password: "anything" } });
  assert.equal(passwordLogin.status, 401, "微信新账号无默认或共享 H5 密码");
  const disabled = await api(`/admin/users/${approved.data.user.id}`, { method: "PUT", token: adminToken,
    body: { name: approved.data.user.name, role: "operator", status: "disabled", canDownload: false } });
  assert.equal(disabled.status, 200);
  assert.deepEqual((await api("/auth/wechat/session", { method: "POST", body: { code: "applicant4" } })).data, { status: "disabled" });
  assert.equal((await api("/me", { token: login.data.token })).data.user, null);
}));

test("审核绑定已有账号保持 userId；一人一微信冲突被拒绝", () => withServer(async ({ api, adminToken }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken, body: {
    username: "owner-shanghai", password: "owner-password", name: "原主办方", role: "operator", canDownload: true
  } });
  assert.equal(created.status, 201);
  const existing = created.data.user;
  const apply = await api("/auth/wechat/apply", { method: "POST", body: {
    code: "existing1", name: "原主办方", contact: "13900000000"
  } });
  assert.equal(apply.status, 201);
  const list = await api("/admin/wechat/applications", { token: adminToken });
  const identityId = list.data.applications[0].id;
  const approved = await api(`/admin/wechat/applications/${identityId}/approve`, { method: "POST", token: adminToken,
    body: { userId: existing.id, role: "admin", confirmNoExistingAccount: false } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.user.id, existing.id);
  assert.equal(approved.data.user.role, "operator", "申请不能改变已有角色");
  const wxLogin = await api("/auth/wechat/session", { method: "POST", body: { code: "existing2" } });
  assert.equal(wxLogin.data.user.id, existing.id);
  const h5Login = await api("/login", { method: "POST", body: { username: "owner-shanghai", password: "owner-password" } });
  assert.equal(h5Login.data.user.id, wxLogin.data.user.id);
  const conflict = await api("/auth/wechat/bind", { method: "POST", body: {
    code: "conflict", username: "owner-shanghai", password: "owner-password"
  } });
  assert.equal(conflict.status, 409);
  const identities = await api("/admin/wechat/applications", { token: adminToken });
  assert.equal(identities.data.applications.filter(item => item.status === "approved").length, 1);
  const revoked = await api(`/admin/wechat/applications/${identityId}/revoke`, { method: "POST", token: adminToken, body: {} });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await api("/auth/wechat/session", { method: "POST", body: { code: "existing3" } })).data, { status: "revoked" });
  assert.equal((await api("/me", { token: h5Login.data.token })).data.user, null, "换绑时撤销原平台会话");
  assert.equal((await api(`/admin/wechat/applications/${identityId}/reopen`, {
    method: "POST", token: adminToken, body: {}
  })).status, 200);
  assert.equal((await api(`/admin/wechat/applications/${identityId}/approve`, {
    method: "POST", token: adminToken, body: { userId: existing.id }
  })).status, 200);
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "existing4" } })).data.user.id, existing.id);
}));

test("同一人分别从 H5 和微信申请时，总部可合并到 H5 待审 userId", () => withServer(async ({ api, adminToken }) => {
  const h5 = await api("/register", { method: "POST", body: {
    username: "city-member-1", password: "chosen-password", name: "同一申请人",
    contact: "13700000000", city: "绍兴", organization: "本地俱乐部"
  } });
  assert.equal(h5.status, 201);
  const users = await api("/admin/users", { token: adminToken });
  const pending = users.data.users.find(user => user.username === "city-member-1");
  assert.equal(pending.status, "pending");
  assert.equal(pending.role, "viewer");
  assert.equal(pending.applicationContact, "13700000000");
  assert.equal((await api("/login", { method: "POST", body: {
    username: "city-member-1", password: "chosen-password"
  } })).status, 401);
  assert.equal((await api("/auth/wechat/apply", { method: "POST", body: {
    code: "existing1", name: "同一申请人", contact: "13700000000", city: "绍兴"
  } })).status, 201);
  const identityId = (await api("/admin/wechat/applications", { token: adminToken })).data.applications[0].id;
  const approved = await api(`/admin/wechat/applications/${identityId}/approve`, { method: "POST", token: adminToken,
    body: { userId: pending.id, role: "member", canDownload: true } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.created, false);
  assert.equal(approved.data.user.id, pending.id);
  const h5Login = await api("/login", { method: "POST", body: { username: "city-member-1", password: "chosen-password" } });
  const wxLogin = await api("/auth/wechat/session", { method: "POST", body: { code: "existing2" } });
  assert.equal(h5Login.data.user.id, wxLogin.data.user.id);
  assert.equal(wxLogin.data.user.role, "member");
}));

test("账号级 SOP 下载禁用在服务端生效，不依赖隐藏按钮", () => withServer(async ({ api, adminToken }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken, body: {
    username: "no-download", password: "test-password", name: "无下载权限", role: "viewer", canDownload: false
  } });
  assert.equal(created.status, 201);
  const logged = await api("/login", { method: "POST", body: { username: "no-download", password: "test-password" } });
  assert.equal(logged.data.user.canDownload, false);
  assert.equal((await api("/public/activities/act_download_test/download.pdf", { token: logged.data.token })).status, 403);
  const enabled = await api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken,
    body: { name: "无下载权限", role: "viewer", status: "active", canDownload: true } });
  assert.equal(enabled.status, 200);
  assert.equal((await api("/public/activities/act_download_test/download.pdf", { token: logged.data.token })).status, 200);
}));
