const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function renewalFixture({ hoursRemaining = 6, status = "active", suspended = false, revoked = false, bindingStatus = "approved" } = {}) {
  const expiry = Date.now() + hoursRemaining * 60 * 60 * 1000;
  const createdAt = new Date(expiry - 7 * 24 * 60 * 60 * 1000).toISOString();
  const user = { id: "renewal_owner", username: "renewal-owner", name: "续登主理人", role: "operator", status,
    canDownload: true, salt: "fixture-salt", passwordHash: crypto.createHash("sha256").update("fixture-salt:fixture-password").digest("hex"),
    createdAt, ...(suspended ? { wechatBindingSuspended: true } : {}),
    ...(revoked ? { sessionRevokedAt: new Date().toISOString() } : {}) };
  return {
    users: [{ id: user.id, username: user.username, role: user.role, status: user.status, created_at: createdAt, doc: JSON.stringify(user) }],
    sessions: [{ token: "original-renewal-token", user_id: user.id, created_at: createdAt, expires_at: new Date(expiry).toISOString() }],
    wechat_identities: [{ id: "renewal_identity", appid: "wx-test", openid: "openid-conflict", user_id: user.id, status: bindingStatus,
      name: user.name, contact: "13800000000", city: "绍兴", organization: "测试", created_at: createdAt, updated_at: createdAt }]
  };
}

async function withServer(run, { extraSeed = {} } = {}) {
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
    const dumpFile = path.join(dir, "db-dump.json");
    const gateFile = path.join(dir, "query-gate.json");
    const wechatGateFile = path.join(dir, "wechat-gate.json");
    const activity = { id: "act_download_test", title: "下载权限测试活动", status: "published", downloadEnabled: true,
      city: "上海", category: "同城活动", createdAt: new Date().toISOString(), plan: { target: "测试" } };
    fs.writeFileSync(seed, JSON.stringify({ ...extraSeed, users: [{
      id: admin.id, username: admin.username, role: admin.role, status: admin.status,
      doc: JSON.stringify(admin), created_at: admin.createdAt
    }, ...(extraSeed.users || [])], activities: [{ id: activity.id, status: activity.status, city: activity.city, category: activity.category,
      sort_order: 1, created_at: activity.createdAt, doc: JSON.stringify(activity) }] }));
    const port = 21000 + Math.floor(Math.random() * 20000);
    const codes = { applicant1: "openid-first", applicant2: "openid-first", applicant3: "openid-first",
      applicant4: "openid-first", existing1: "openid-existing", existing2: "openid-existing",
      existing3: "openid-existing", existing4: "openid-existing",
      conflict: "openid-conflict" };
    child = spawn(process.execPath, ["--require", path.join(ROOT, "tests/concurrency/preload.js"), "server.js"], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), FAKE_DB_SEED: seed, FAKE_DB_DUMP: dumpFile, FAKE_WECHAT_CODES: JSON.stringify(codes),
        FAKE_DB_GATE_FILE: gateFile, FAKE_WECHAT_GATE_FILE: wechatGateFile,
        WECHAT_MINIAPP_APPID: "wx-test", WECHAT_MINIAPP_SECRET: "test-only-secret" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    child.stdout.on("data", chunk => { log += chunk; });
    child.stderr.on("data", chunk => { log += chunk; });
    for (let i = 0; i < 100 && !log.includes("running at"); i++) await sleep(100);
    if (!log.includes("running at")) throw new Error(`server did not start: ${log}`);
    const api = async (route, { method = "GET", token, cookie, origin, contentType, body, rawBody } = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: `silver_session=${cookie}` } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(body || rawBody ? { "Content-Type": contentType || "application/json" } : {})
        },
        body: rawBody !== undefined ? rawBody : body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { text }; }
      return { status: response.status, data };
    };
    const logged = await api("/login", { method: "POST", body: { username: "test-admin", password: "test-password" } });
    assert.equal(logged.status, 200, log);
    const makeGate = (configFile, details) => {
      const id = crypto.randomBytes(8).toString("hex");
      const enteredFile = path.join(dir, `${id}.entered`);
      const releaseFile = path.join(dir, `${id}.released`);
      fs.writeFileSync(configFile, JSON.stringify({ id, ...details, enteredFile, releaseFile }));
      return {
        async entered() {
          for (let i = 0; i < 500 && !fs.existsSync(enteredFile); i++) await sleep(5);
          assert.equal(fs.existsSync(enteredFile), true, "请求应进入指定的异步数据库边界");
        },
        release() { fs.writeFileSync(releaseFile, "released"); }
      };
    };
    const gate = (sqlIncludes, { paramsInclude = [], occurrence = 1 } = {}) => makeGate(gateFile, { sqlIncludes, paramsInclude, occurrence });
    const wechatGate = code => makeGate(wechatGateFile, { code });
    await run({ api, adminToken: logged.data.token, port, gate, wechatGate,
      persisted: () => JSON.parse(fs.readFileSync(dumpFile, "utf8")) });
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
  const pendingSession = await api("/auth/wechat/session", { method: "POST", body: { code: "applicant2" } });
  assert.equal(pendingSession.data.status, "pending");
  assert.equal(pendingSession.data.fingerprint.length, 12);
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
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "applicant4" } })).data.status, "disabled");
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
  const userList = await api("/admin/users", { token: adminToken });
  const boundUser = userList.data.users.find(item => item.id === existing.id);
  assert.equal(boundUser.wechatBinding.id, identityId, "用户卡片不依赖最近30条审核记录，也能找到绑定与解绑入口");
  assert.equal(boundUser.wechatBinding.fingerprint.length, 12);
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
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "existing3" } })).data.status, "revoked");
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

test("密码重置解除微信绑定并撤销旧会话；停用再启用不复活旧 token", () => withServer(async ({ api, adminToken }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken, body: {
    username: "reset-owner", password: "old-password", name: "测试主办方", role: "operator"
  } });
  const userId = created.data.user.id;
  const bound = await api("/auth/wechat/bind", { method: "POST", body: {
    code: "conflict", username: "reset-owner", password: "old-password"
  } });
  assert.equal(bound.status, 200);
  const reset = await api(`/admin/users/${userId}`, { method: "PUT", token: adminToken, body: {
    name: "测试主办方", role: "operator", status: "active", password: "new-password"
  } });
  assert.equal(reset.status, 200);
  assert.equal((await api("/me", { token: bound.data.token })).data.user, null);
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "conflict" } })).data.status, "revoked");
  assert.equal((await api("/login", { method: "POST", body: { username: "reset-owner", password: "old-password" } })).status, 401);
  const relogged = await api("/login", { method: "POST", body: { username: "reset-owner", password: "new-password" } });
  assert.equal(relogged.status, 200);
  assert.equal((await api(`/admin/users/${userId}`, { method: "PUT", token: adminToken, body: {
    name: "测试主办方", role: "operator", status: "disabled"
  } })).status, 200);
  assert.equal((await api(`/admin/users/${userId}`, { method: "PUT", token: adminToken, body: {
    name: "测试主办方", role: "operator", status: "active"
  } })).status, 200);
  assert.equal((await api("/me", { token: relogged.data.token })).data.user, null);
}));

test("H5 待审账号正确密码不计为绑定失败；总部管理员不能自绑微信", () => withServer(async ({ api }) => {
  assert.equal((await api("/register", { method: "POST", body: {
    username: "pending-owner", password: "correct-password", name: "待审主办方", contact: "13800000000"
  } })).status, 201);
  for (let i = 0; i < 6; i++) {
    const pending = await api("/auth/wechat/bind", { method: "POST", body: {
      code: "conflict", username: "pending-owner", password: "correct-password"
    } });
    assert.equal(pending.status, 403);
    assert.match(pending.data.error, /待总部审核/);
  }
  const admin = await api("/auth/wechat/bind", { method: "POST", body: {
    code: "conflict", username: "test-admin", password: "test-password"
  } });
  assert.equal(admin.status, 403);
  assert.match(admin.data.error, /总部管理员/);
}));

test("外站不能借管理员 Cookie 用简单表单请求创建账号", () => withServer(async ({ api, adminToken, port }) => {
  const forged = await api("/admin/users", { method: "POST", cookie: adminToken,
    origin: "https://untrusted.example", contentType: "text/plain",
    rawBody: JSON.stringify({ username: "csrf-admin", password: "stolen", role: "admin" })
  });
  assert.equal(forged.status, 403);
  const users = await api("/admin/users", { token: adminToken });
  assert.equal(users.data.users.some(user => user.username === "csrf-admin"), false);
  const trusted = await api("/admin/users", { method: "POST", cookie: adminToken,
    origin: `http://127.0.0.1:${port}`,
    body: { username: "trusted-origin", password: "local-password", role: "viewer" }
  });
  assert.equal(trusted.status, 201, "已信任 H5 页面保留原有 Cookie 写入能力");
}));

test("微信新账号首次补建 H5 密码保留绑定、账号 ID 和已有相册归属", () => withServer(async ({ api, adminToken, persisted }) => {
  await api("/auth/wechat/apply", { method: "POST", body: { code: "applicant1", name: "绍兴主理人", contact: "13800000000" } });
  const identityId = (await api("/admin/wechat/applications", { token: adminToken })).data.applications[0].id;
  const approved = await api(`/admin/wechat/applications/${identityId}/approve`, { method: "POST", token: adminToken,
    body: { confirmNoExistingAccount: true, role: "operator", canDownload: true } });
  const userId = approved.data.user.id;
  const originalWechat = await api("/auth/wechat/session", { method: "POST", body: { code: "applicant2" } });
  const album = await api("/my/activity-projects", { method: "POST", token: originalWechat.data.token, body: { title: "已有交付相册" } });
  const setup = await api(`/admin/users/${userId}`, { method: "PUT", token: adminToken,
    body: { username: "shaoxing-owner", password: "first-h5-password" } });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.user.id, userId);
  assert.equal((await api("/me", { token: originalWechat.data.token })).data.user, null, "账号登录凭据变化仍撤销旧会话");
  const wxLogin = await api("/auth/wechat/session", { method: "POST", body: { code: "applicant3" } });
  const h5Login = await api("/login", { method: "POST", body: { username: "shaoxing-owner", password: "first-h5-password" } });
  assert.equal(wxLogin.status, 200);
  assert.equal(wxLogin.data.user.id, userId, "首次补建 H5 密码不解除已核实的微信绑定");
  assert.equal(h5Login.data.user.id, userId);
  const detail = await api(`/my/activity-projects/${album.data.project.id}`, { token: wxLogin.data.token });
  assert.equal(detail.data.project.canManage, true);
  assert.equal(persisted().activity_projects.find(item => item.id === album.data.project.id).owner_id, userId);
  const account = (await api("/admin/users", { token: adminToken })).data.users.find(item => item.id === userId);
  assert.equal(account.wechatBinding.id, identityId);
  assert.equal(account.hasPassword, true);
}));

test("通用微信申请不能升级总部角色或匹配管理员；一平台账号不接受第二微信", () => withServer(async ({ api, adminToken }) => {
  const apply = code => api("/auth/wechat/apply", { method: "POST", body: {
    code, name: "普通申请人", contact: "13800000000", role: "admin", canDownload: true
  } });
  assert.equal((await apply("applicant1")).status, 201);
  let pending = (await api("/admin/wechat/applications", { token: adminToken })).data.applications[0];
  const adminMatch = await api(`/admin/wechat/applications/${pending.id}/approve`, { method: "POST", token: adminToken,
    body: { userId: "test_admin" } });
  assert.equal(adminMatch.status, 403);
  const approved = await api(`/admin/wechat/applications/${pending.id}/approve`, { method: "POST", token: adminToken,
    body: { confirmNoExistingAccount: true, role: "admin", canDownload: false } });
  assert.equal(approved.data.user.role, "viewer", "审批请求不能通过伪造 role 建立总部管理员");
  assert.equal(approved.data.user.canDownload, false);
  assert.equal((await apply("existing1")).status, 201);
  pending = (await api("/admin/wechat/applications", { token: adminToken })).data.applications.find(row => row.status === "pending");
  const duplicateMatch = await api(`/admin/wechat/applications/${pending.id}/approve`, { method: "POST", token: adminToken,
    body: { userId: approved.data.user.id } });
  assert.equal(duplicateMatch.status, 409);
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "applicant2" } })).data.user.id, approved.data.user.id);
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "existing2" } })).data.status, "pending");
}));

test("并发提交同一账号与同一微信申请只生成一条记录，拒绝后不能越过审批", () => withServer(async ({ api, adminToken }) => {
  const registrations = await Promise.all(["Same-Applicant", "same-applicant"].map(username => api("/register", {
    method: "POST", body: { username, password: "user-password", name: "同一个用户", contact: "13800000000", role: "admin" }
  })));
  assert.deepEqual(registrations.map(result => result.status).sort(), [201, 409]);
  const users = (await api("/admin/users", { token: adminToken })).data.users.filter(row => row.username === "same-applicant");
  assert.equal(users.length, 1);
  assert.equal(users[0].status, "pending");
  assert.equal(users[0].role, "viewer");
  const applications = await Promise.all(["existing1", "existing2"].map(code => api("/auth/wechat/apply", {
    method: "POST", body: { code, name: "同一个用户", contact: "13800000000" }
  })));
  assert.deepEqual(applications.map(result => result.status).sort(), [200, 201]);
  const pending = (await api("/admin/wechat/applications", { token: adminToken })).data.applications;
  assert.equal(pending.length, 1);
  assert.equal((await api(`/admin/wechat/applications/${pending[0].id}/reject`, { method: "POST", token: adminToken, body: {} })).status, 200);
  const rejected = await api("/auth/wechat/session", { method: "POST", body: { code: "existing3" } });
  assert.equal(rejected.data.status, "rejected");
  assert.equal(rejected.data.token, undefined);
  assert.equal((await api(`/admin/wechat/applications/${pending[0].id}/approve`, { method: "POST", token: adminToken,
    body: { userId: users[0].id } })).status, 409);
}));

test("微信绑定核验原密码期间重置密码必须排队，不能重新激活旧绑定", () => withServer(async ({ api, adminToken, gate }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "race-owner", password: "old-password", role: "operator" } });
  const boundary = gate("SELECT * FROM wechat_identities WHERE appid = ? AND openid = ? FOR UPDATE", { paramsInclude: ["openid-conflict"] });
  const bind = api("/auth/wechat/bind", { method: "POST", body: { code: "conflict", username: "race-owner", password: "old-password" } });
  await boundary.entered();
  let resetDone = false;
  const reset = api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken,
    body: { password: "new-password" } }).then(result => { resetDone = true; return result; });
  await sleep(40);
  assert.equal(resetDone, false, "原密码核验到签发会话期间，密码重置不能插入");
  boundary.release();
  const [bound, changed] = await Promise.all([bind, reset]);
  assert.equal(bound.status, 200);
  assert.equal(changed.status, 200);
  assert.equal((await api("/me", { token: bound.data.token })).data.user, null);
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "conflict" } })).data.status, "revoked");
  assert.equal((await api("/login", { method: "POST", body: { username: "race-owner", password: "old-password" } })).status, 401);
  assert.equal((await api("/login", { method: "POST", body: { username: "race-owner", password: "new-password" } })).status, 200);
}));

test("微信签发会话跨数据库等待时停用不能插队，重新启用不复活旧 token", () => withServer(async ({ api, adminToken, gate }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "race-session", password: "user-password", role: "operator" } });
  await api("/auth/wechat/bind", { method: "POST", body: { code: "conflict", username: "race-session", password: "user-password" } });
  const boundary = gate("SELECT * FROM wechat_identities WHERE appid = ? AND openid = ?", {
    paramsInclude: ["openid-conflict"], occurrence: 2
  });
  const login = api("/auth/wechat/session", { method: "POST", body: { code: "conflict" } });
  await boundary.entered();
  let disabledDone = false;
  const disable = api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken,
    body: { status: "disabled" } }).then(result => { disabledDone = true; return result; });
  await sleep(40);
  assert.equal(disabledDone, false, "读取绑定到持久化登录态是完整授权操作");
  boundary.release();
  const [logged, changed] = await Promise.all([login, disable]);
  assert.equal(logged.status, 200);
  assert.equal(changed.status, 200);
  assert.equal((await api("/me", { token: logged.data.token })).data.user, null);
  assert.equal((await api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken, body: { status: "active" } })).status, 200);
  assert.equal((await api("/me", { token: logged.data.token })).data.user, null);
}));

test("密码会话写入期间停用不能插队，拒绝状态阻断新的密码和微信登录", () => withServer(async ({ api, adminToken, gate }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "race-password", password: "user-password", role: "operator" } });
  const boundary = gate("DELETE FROM sessions");
  const login = api("/login", { method: "POST", body: { username: "race-password", password: "user-password" } });
  await boundary.entered();
  let rejectedDone = false;
  const reject = api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken,
    body: { status: "rejected" } }).then(result => { rejectedDone = true; return result; });
  await sleep(40);
  assert.equal(rejectedDone, false);
  boundary.release();
  const [logged, changed] = await Promise.all([login, reject]);
  assert.equal(logged.status, 200);
  assert.equal(changed.status, 200);
  assert.equal((await api("/me", { token: logged.data.token })).data.user, null);
  assert.equal((await api("/login", { method: "POST", body: { username: "race-password", password: "user-password" } })).status, 401);
  assert.equal((await api("/auth/wechat/bind", { method: "POST", body: { code: "conflict", username: "race-password", password: "user-password" } })).status, 403);
}));

test("登录与 me 返回同一会话的七天期限；匿名和未知 token 不泄露会话资料", () => withServer(async ({ api, adminToken }) => {
  const started = Date.now();
  const login = await api("/login", { method: "POST", body: { username: "test-admin", password: "test-password" } });
  assert.equal(login.data.loginMethod, "password");
  assert.ok(new Date(login.data.sessionExpiresAt).getTime() >= started + 7 * 24 * 60 * 60 * 1000);
  assert.ok(new Date(login.data.sessionExpiresAt).getTime() <= Date.now() + 7 * 24 * 60 * 60 * 1000);
  const me = await api("/me", { token: login.data.token });
  assert.equal(me.data.user.id, login.data.user.id);
  assert.equal(me.data.sessionExpiresAt, login.data.sessionExpiresAt);
  assert.deepEqual((await api("/me")).data, { user: null });
  assert.deepEqual((await api("/me", { token: "unknown-token" })).data, { user: null });
  assert.equal((await api("/auth/wechat/session", { method: "POST", token: adminToken,
    body: { code: "conflict", autoRenew: true } })).status, 403, "总部账号不能自动微信续登");
}));

test("原有效 Bearer 在24小时内可凭同一微信续登，保留旧 token 不中断已开始的上传", () => withServer(async ({ api, persisted }) => {
  const old = await api("/me", { token: "original-renewal-token" });
  const before = Date.now();
  const renewed = await api("/auth/wechat/session", { method: "POST", token: "original-renewal-token",
    body: { code: "conflict", autoRenew: true } });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.user.id, old.data.user.id);
  assert.equal(renewed.data.loginMethod, "wechat-miniapp");
  assert.notEqual(renewed.data.token, "original-renewal-token");
  assert.ok(new Date(renewed.data.sessionExpiresAt).getTime() >= before + 7 * 24 * 60 * 60 * 1000);
  assert.ok(new Date(renewed.data.sessionExpiresAt).getTime() <= Date.now() + 7 * 24 * 60 * 60 * 1000);
  assert.equal((await api("/me", { token: "original-renewal-token" })).data.sessionExpiresAt, old.data.sessionExpiresAt);
  assert.equal((await api("/me", { token: renewed.data.token })).data.sessionExpiresAt, renewed.data.sessionExpiresAt);
  assert.equal(persisted().sessions.filter(row => row.user_id === old.data.user.id).length, 2);
}, { extraSeed: renewalFixture() }));

test("过早自动续登仍核验同一微信，返回原 token 和原期限而不新增会话", () => withServer(async ({ api, persisted }) => {
  const old = await api("/me", { token: "original-renewal-token" });
  const before = persisted().sessions.length;
  const renewed = await api("/auth/wechat/session", { method: "POST", token: "original-renewal-token",
    body: { code: "conflict", autoRenew: true } });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.token, "original-renewal-token");
  assert.equal(renewed.data.sessionExpiresAt, old.data.sessionExpiresAt);
  assert.equal(persisted().sessions.length, before);
  const foreign = await api("/auth/wechat/session", { method: "POST", token: "original-renewal-token",
    body: { code: "existing1", autoRenew: true } });
  assert.equal(foreign.status, 403, "不能因过早续登跳过微信匹配");
  assert.equal(foreign.data.token, undefined);
  assert.equal(persisted().sessions.length, before);
}, { extraSeed: renewalFixture({ hoursRemaining: 48 }) }));

test("自动续登需要真实有效 Bearer；匿名、未知、仅Cookie和另一微信不能取新 token", () => withServer(async ({ api, persisted }) => {
  const before = persisted().sessions.length;
  for (const options of [{}, { token: "unknown-token" }, { cookie: "original-renewal-token", origin: "https://proj2.likeduoduiyi.cn" }]) {
    const denied = await api("/auth/wechat/session", { method: "POST", ...options, body: { code: "conflict", autoRenew: true } });
    assert.equal(denied.status, 401);
    assert.equal(denied.data.token, undefined);
  }
  const foreign = await api("/auth/wechat/session", { method: "POST", token: "original-renewal-token", body: { code: "existing1", autoRenew: true } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.token, undefined);
  assert.equal(persisted().sessions.length, before);
}, { extraSeed: renewalFixture() }));

test("过期、撤销、停用、暂停绑定和未批准身份均不能自动续登", async () => {
  for (const settings of [{ hoursRemaining: -1 }, { revoked: true }, { status: "disabled" },
    { status: "rejected" }, { suspended: true }, { bindingStatus: "revoked" }, { bindingStatus: "pending" }]) {
    await withServer(async ({ api, persisted }) => {
      const before = persisted().sessions.length;
      const denied = await api("/auth/wechat/session", { method: "POST", token: "original-renewal-token", body: { code: "conflict", autoRenew: true } });
      assert.ok([401, 403].includes(denied.status), JSON.stringify(settings));
      assert.equal(denied.data.token, undefined);
      assert.equal(persisted().sessions.length, before);
      if (settings.revoked || settings.hoursRemaining < 0) {
        const explicit = await api("/auth/wechat/session", { method: "POST", body: { code: "conflict" } });
        assert.equal(explicit.status, 200);
        assert.equal(explicit.data.user.id, "renewal_owner", "仍启用且绑定有效的用户可主动重新验证微信登录");
      }
    }, { extraSeed: renewalFixture(settings) });
  }
});

test("另一已批准账号的微信 code 不能续登当前账号，两边账号和权限不变", () => withServer(async ({ api, adminToken }) => {
  const other = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "other-wechat-owner", password: "other-password", role: "viewer", canDownload: false } });
  const binding = await api("/auth/wechat/bind", { method: "POST", body: { code: "existing1", username: "other-wechat-owner", password: "other-password" } });
  assert.equal(binding.status, 200);
  const denied = await api("/auth/wechat/session", { method: "POST", token: "original-renewal-token", body: { code: "existing2", autoRenew: true } });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.token, undefined);
  assert.equal((await api("/me", { token: "original-renewal-token" })).data.user.id, "renewal_owner");
  const otherMe = (await api("/me", { token: binding.data.token })).data.user;
  assert.equal(otherMe.id, other.data.user.id);
  assert.equal(otherMe.role, "viewer");
  assert.equal(otherMe.canDownload, false);
}, { extraSeed: renewalFixture() }));

test("微信 code 交换期间撤销权限、注销或解绑后，自动续登不得恢复旧权限", async () => {
  for (const action of ["disable", "role", "logout", "revoke", "reset-password"]) {
    await withServer(async ({ api, adminToken, wechatGate, persisted }) => {
      const boundary = wechatGate("conflict");
      const renew = api("/auth/wechat/session", { method: "POST", token: "original-renewal-token", body: { code: "conflict", autoRenew: true } });
      await boundary.entered();
      const changed = action === "logout" ? await api("/logout", { method: "POST", token: "original-renewal-token", body: {} })
        : action === "revoke" ? await api("/admin/wechat/applications/renewal_identity/revoke", { method: "POST", token: adminToken, body: {} })
          : await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken,
            body: action === "disable" ? { status: "disabled" } : action === "role" ? { role: "viewer" } : { password: "changed-password" } });
      assert.equal(changed.status, 200, action);
      boundary.release();
      const denied = await renew;
      assert.ok([401, 403].includes(denied.status), action);
      assert.equal(denied.data.token, undefined);
      assert.equal(persisted().sessions.some(row => row.user_id === "renewal_owner"), false);
    }, { extraSeed: renewalFixture() });
  }
});

test("微信续登写入等待期间原 Bearer 自然到期，也不返回新 token", async () => {
  const seed = renewalFixture({ hoursRemaining: 3 / 3600 });
  await withServer(async ({ api, gate, persisted }) => {
    const boundary = gate("DELETE FROM sessions");
    const renew = api("/auth/wechat/session", { method: "POST", token: "original-renewal-token", body: { code: "conflict", autoRenew: true } });
    await boundary.entered();
    await sleep(Math.max(0, new Date(seed.sessions[0].expires_at).getTime() - Date.now()) + 20);
    boundary.release();
    const denied = await renew;
    assert.equal(denied.status, 401);
    assert.equal(denied.data.token, undefined);
    assert.equal(persisted().sessions.some(row => row.user_id === "renewal_owner"), false);
  }, { extraSeed: seed });
});

test("主理人与只读账号不能读取总部申请、审批微信或修改用户为管理员", () => withServer(async ({ api, adminToken }) => {
  await api("/auth/wechat/apply", { method: "POST", body: { code: "applicant1", name: "待审申请人", contact: "13800000000" } });
  const identityId = (await api("/admin/wechat/applications", { token: adminToken })).data.applications[0].id;
  for (const role of ["operator", "viewer"]) {
    const created = await api("/admin/users", { method: "POST", token: adminToken,
      body: { username: `${role}-permission`, password: "user-password", role } });
    const user = created.data.user;
    const login = await api("/login", { method: "POST", body: { username: user.username, password: "user-password" } });
    assert.equal((await api("/admin/wechat/applications", { token: login.data.token })).status, 403);
    assert.equal((await api(`/admin/wechat/applications/${identityId}/approve`, { method: "POST", token: login.data.token,
      body: { userId: user.id, role: "admin" } })).status, 403);
    assert.equal((await api(`/admin/users/${user.id}`, { method: "PUT", token: login.data.token, body: { role: "admin" } })).status, 403);
    const current = (await api("/admin/users", { token: adminToken })).data.users.find(item => item.id === user.id);
    assert.equal(current.role, role);
    assert.equal(current.id, user.id);
  }
  assert.equal((await api("/admin/wechat/applications", { token: adminToken })).data.applications[0].status, "pending");
}));
