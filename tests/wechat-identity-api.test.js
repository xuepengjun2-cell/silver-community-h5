const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

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

async function withServer(run, { extraSeed = {}, wechatSecret = "test-only-secret" } = {}) {
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
    const portFile = path.join(dir, "listener-port");
    const codes = { applicant1: "openid-first", applicant2: "openid-first", applicant3: "openid-first",
      applicant4: "openid-first", existing1: "openid-existing", existing2: "openid-existing",
      existing3: "openid-existing", existing4: "openid-existing",
      conflict: "openid-conflict" };
    child = spawn(process.execPath, ["--require", path.join(ROOT, "tests/concurrency/preload.js"), "server.js"], {
      cwd: dir,
      env: { ...process.env, PORT: "0", FAKE_SERVER_PORT_FILE: portFile, FAKE_DB_SEED: seed, FAKE_DB_DUMP: dumpFile, FAKE_WECHAT_CODES: JSON.stringify(codes),
        FAKE_DB_GATE_FILE: gateFile, FAKE_WECHAT_GATE_FILE: wechatGateFile,
        WECHAT_MINIAPP_APPID: "wx-test", WECHAT_MINIAPP_SECRET: wechatSecret },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    child.stdout.on("data", chunk => { log += chunk; });
    child.stderr.on("data", chunk => { log += chunk; });
    for (let i = 0; i < 100 && !fs.existsSync(portFile) && child.exitCode === null; i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error(`server did not start: ${log}`);
    const port = Number(fs.readFileSync(portFile, "utf8"));
    assert.ok(Number.isInteger(port) && port > 0, "fixture receives OS-assigned listener port");
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
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("案例可匿名预览，但照片与视频下载均拒绝匿名和无效会话", () => {
  const item = {
    id: "case_preview_guard", title: "案例预览测试", status: "published", createdAt: new Date().toISOString(),
    media: [
      { type: "image", url: "https://proj2.likeduoduiyi.cn/silver-images/test.jpg" },
      { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/test.mp4" }
    ]
  };
  return withServer(async ({ api, adminToken }) => {
    const preview = await api(`/public/cases/${item.id}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.case.media.length, 2);
    for (let index = 0; index < item.media.length; index++) {
      const route = `/public/cases/${item.id}/download?i=${index}&format=json`;
      for (const token of [undefined, "expired-or-invalid-token"]) {
        const denied = await api(route, { token });
        assert.equal(denied.status, 401);
        assert.equal(denied.data.url, undefined);
      }
      const allowed = await api(route, { token: adminToken });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.data.url, item.media[index].url);
    }
  }, { extraSeed: { cases: [{ id: item.id, status: item.status, created_at: item.createdAt, doc: JSON.stringify(item) }] } });
});

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
  assert.equal((await api("/public/activities/act_download_test/download.pdf", { token: logged.data.token })).status, 401, "权限变化撤销旧会话，不能由旧 token 恢复旧权限");
  const refreshed = await api("/login", { method: "POST", body: { username: "no-download", password: "test-password" } });
  assert.equal((await api("/public/activities/act_download_test/download.pdf", { token: refreshed.data.token })).status, 200);
  assert.equal((await api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken, body: { canDownload: false } })).status, 200);
  assert.equal((await api("/public/activities/act_download_test/download.pdf", { token: refreshed.data.token })).status, 401);
  const revoked = await api("/login", { method: "POST", body: { username: "no-download", password: "test-password" } });
  assert.equal((await api("/public/activities/act_download_test/download.pdf", { token: revoked.data.token })).status, 403);
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
  for (const action of ["disable", "role", "logout", "revoke", "reset-password", "album-scope", "download"]) {
    await withServer(async ({ api, adminToken, wechatGate, persisted }) => {
      const boundary = wechatGate("conflict");
      const renew = api("/auth/wechat/session", { method: "POST", token: "original-renewal-token", body: { code: "conflict", autoRenew: true } });
      await boundary.entered();
      const changed = action === "logout" ? await api("/logout", { method: "POST", token: "original-renewal-token", body: {} })
        : action === "revoke" ? await api("/admin/wechat/applications/renewal_identity/revoke", { method: "POST", token: adminToken, body: {} })
          : await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken,
            body: action === "disable" ? { status: "disabled" } : action === "role" ? { role: "viewer" }
              : action === "album-scope" ? { albumReadScope: "own-and-selected", albumReadProjectIds: [] }
                : action === "download" ? { canDownload: false } : { password: "changed-password" } });
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

function albumScopeFixture() {
  const seed = renewalFixture();
  const makeProject = (id, ownerId, { status = "published", shareEnabled = true } = {}) => {
    const project = { id, ownerId, title: `${id}-title`, status, shareEnabled, media: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return { id, owner_id: ownerId, status, created_at: project.createdAt, updated_at: project.updatedAt, doc: JSON.stringify(project) };
  };
  seed.activity_projects = [makeProject("project_own", "renewal_owner"),
    makeProject("project_selected", "other_owner", { shareEnabled: false }),
    makeProject("project_hidden", "other_owner", { status: "draft", shareEnabled: false }),
    makeProject("project_shared", "other_owner")];
  seed.project_upload_sessions = [{ id: "scope-hidden-session", project_id: "project_hidden", owner_id: "other_owner",
    status: "uploading", filename: "hidden.mp4", object_key: "hidden-object", upload_id: "hidden-upload",
    file_size: 1024, part_size: 1024, part_count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  return seed;
}

test("公开能力接口只返回布尔值，配置存在不等同于已完成真实微信核验", () => withServer(async ({ api }) => {
  const result = await api("/auth/capabilities");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { capabilities: { passwordLogin: true, wechatLogin: true } });
  assert.equal(JSON.stringify(result.data).includes("test-only-secret"), false);
}));

test("未配置微信时能力为 false，微信会话仍 503 且平台密码登录可用", () => withServer(async ({ api, adminToken, persisted }) => {
  assert.deepEqual((await api("/auth/capabilities")).data, { capabilities: { passwordLogin: true, wechatLogin: false } });
  const denied = await api("/auth/wechat/session", { method: "POST", body: { code: "applicant1" } });
  assert.equal(denied.status, 503);
  assert.equal(denied.data.token, undefined);
  assert.equal((await api("/me", { token: adminToken })).data.user.role, "admin");
  assert.equal((persisted().wechat_identities || []).length, 0);
}, { wechatSecret: "" }));

test("内部相册范围过滤列表和详情；本人可管理、指定仅可读、公开分享仍单相册可用", () => withServer(async ({ api, adminToken }) => {
  const before = await api("/my/activity-projects", { token: "original-renewal-token" });
  assert.equal(before.data.projects.length, 4, "历史未设置账号保留全部可见");
  const updated = await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken,
    body: { albumReadScope: "own-and-selected", albumReadProjectIds: ["project_selected"] } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.user.albumReadProjectIds, undefined, "通用 publicUser 不返回内部白名单");
  assert.equal((await api("/me", { token: "original-renewal-token" })).data.user, null, "查看权限变化即撤销旧会话");
  let login = await api("/login", { method: "POST", body: { username: "renewal-owner", password: "fixture-password" } });
  const token = login.data.token;
  assert.equal(login.data.user.albumReadProjectIds, undefined);
  const list = await api("/my/activity-projects", { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 2, "数量也只统计可见范围");
  assert.deepEqual(list.data.projects.map(p => p.id).sort(), ["project_own", "project_selected"]);
  assert.equal(list.data.projects.find(p => p.id === "project_own").canManage, true);
  assert.equal(list.data.projects.find(p => p.id === "project_selected").canManage, false);
  assert.equal(JSON.stringify(list.data).includes("project_hidden"), false);
  assert.equal(JSON.stringify(list.data).includes("project_shared"), false);
  for (const id of ["project_hidden", "project_shared"]) assert.equal((await api(`/my/activity-projects/${id}`, { token })).status, 404);
  assert.equal((await api("/my/activity-projects/project_selected", { token })).status, 200);
  for (const [method, route, body] of [
    ["PATCH", "/my/activity-projects/project_selected", { title: "不得修改" }],
    ["DELETE", "/my/activity-projects/project_selected", {}],
    ["DELETE", "/my/activity-projects/project_selected/media/0", {}],
    ["POST", "/my/activity-projects/project_selected/media/init", { type: "video", ext: "mp4", size: 1024 }]
  ]) assert.equal((await api(route, { method, token, body })).status, 403, route);
  assert.equal((await api("/my/activity-projects/project_own", { method: "PATCH", token, body: { title: "本人可修改" } })).status, 200);
  for (const route of [
    "/my/activity-projects/project_hidden/media/upload-sessions",
    "/my/activity-projects/project_hidden/media/upload-session/scope-hidden-session/status",
    "/my/activity-projects/project_hidden/media/upload-session/scope-hidden-session/part-url?partNumber=1",
    "/my/activity-projects/project_hidden/miniapp-media/miniapp_000000000000000000000000"
  ]) {
    const denied = await api(route, { token });
    assert.equal(denied.status, 404, "关联任务读取不能绕过相册范围，即便上传会话确实存在");
    assert.equal(denied.data.error, "活动相册不存在或没有查看权限", "应先拒绝相册读取，不查询或披露任务存在性");
  }
  const created = await api("/my/activity-projects", { method: "POST", token, body: { title: "新建演示相册" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.project.canManage, true);
  assert.equal((await api(`/my/activity-projects/${created.data.project.id}`, { token })).status, 200, "本人新建相册无需额外人工添加");
  const approved = (await api("/admin/users", { token: adminToken })).data.users.find(u => u.id === "renewal_owner");
  assert.equal(approved.albumReadScope, "own-and-selected");
  assert.deepEqual(approved.albumReadProjectIds, ["project_selected"]);
  assert.equal((await api("/admin/users/renewal_owner", { method: "PUT", token, body: { albumReadScope: "all" } })).status, 403);
  assert.equal((await api("/admin/users", { token })).status, 403);
  assert.equal((await api("/admin/users")).status, 401);
  for (const shareToken of [undefined, token]) {
    const shared = await api("/public/activity-projects/project_shared", { token: shareToken });
    assert.equal(shared.status, 200, "分享链接仍可单独访问，不受内部列表范围影响");
    assert.deepEqual(Object.keys(shared.data), ["project"]);
    assert.equal(shared.data.project.id, "project_shared");
    assert.equal(shared.data.project.ownerId, undefined);
    assert.equal(shared.data.project.ownerName, undefined);
    assert.equal(shared.data.project.albumReadProjectIds, undefined);
    assert.equal(JSON.stringify(shared.data).includes("project_hidden"), false);
  }
  assert.equal((await api("/public/activity-projects/project_selected")).status, 404);
  assert.equal((await api("/public/activity-projects")).status, 404);
  assert.equal((await api("/my/activity-projects")).status, 401);
  const removed = await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken,
    body: { albumReadScope: "own-and-selected", albumReadProjectIds: [] } });
  assert.equal(removed.status, 200);
  assert.equal((await api("/my/activity-projects", { token })).status, 401, "撤回指定相册同时撤销已有会话");
  login = await api("/login", { method: "POST", body: { username: "renewal-owner", password: "fixture-password" } });
  assert.equal((await api("/my/activity-projects/project_selected", { token: login.data.token })).status, 404);
  assert.equal((await api("/admin/activity-projects", { token: adminToken })).data.projects.length, 5, "总部仍可见全部相册");
}, { extraSeed: albumScopeFixture() }));

test("范围参数校验原子化、管理员始终all；普通申请不能自设相册或下载权限", () => withServer(async ({ api, adminToken, persisted }) => {
  for (const body of [
    { albumReadScope: "unknown" },
    { albumReadScope: "own-and-selected", albumReadProjectIds: "project_own" },
    { albumReadScope: "own-and-selected", albumReadProjectIds: ["project_missing"] },
    { albumReadScope: "all", albumReadProjectIds: [null] }
  ]) {
    assert.equal((await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken, body: { ...body, name: "不应写入" } })).status, 400);
    const user = (await api("/admin/users", { token: adminToken })).data.users.find(u => u.id === "renewal_owner");
    assert.equal(user.name, "续登主理人");
    assert.equal(user.albumReadScope, "all");
    assert.equal((await api("/me", { token: "original-renewal-token" })).data.user.id, "renewal_owner");
  }
  const invalidCreate = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "invalid-scope-user", password: "valid-password", albumReadScope: "own-and-selected", albumReadProjectIds: ["project_missing"] } });
  assert.equal(invalidCreate.status, 400);
  assert.equal((await api("/admin/users", { token: adminToken })).data.users.some(u => u.username === "invalid-scope-user"), false);
  const adminUpdate = await api("/admin/users/test_admin", { method: "PUT", token: adminToken,
    body: { albumReadScope: "invalid", albumReadProjectIds: "invalid" } });
  assert.equal(adminUpdate.status, 200, "总部忽略普通范围字段，始终all");
  const admin = (await api("/admin/users", { token: adminToken })).data.users.find(u => u.id === "test_admin");
  assert.equal(admin.albumReadScope, "all");
  assert.deepEqual(admin.albumReadProjectIds, []);
  const registered = await api("/register", { method: "POST", body: { username: "scope-applicant", password: "applicant-password",
    name: "普通申请人", contact: "13800000000", role: "admin", canDownload: true,
    albumReadScope: "own-and-selected", albumReadProjectIds: ["project_hidden"] } });
  assert.equal(registered.status, 201);
  const pending = JSON.parse(persisted().users.find(row => row.username === "scope-applicant").doc);
  assert.equal(pending.role, "viewer");
  assert.equal(pending.status, "pending");
  assert.equal(pending.canDownload, false);
  assert.equal(pending.albumReadScope, undefined);
  assert.equal(pending.albumReadProjectIds, undefined);
}, { extraSeed: albumScopeFixture() }));

test("总部可直接创建受限演示账号，空白名单只见本人新建，等价授权不注销当前会话", () => withServer(async ({ api, adminToken }) => {
  const created = await api("/admin/users", { method: "POST", token: adminToken, body: {
    username: "review-demo", password: "test-review-password", role: "member", canDownload: true,
    albumReadScope: "own-and-selected", albumReadProjectIds: []
  } });
  assert.equal(created.status, 201);
  const user = created.data.user;
  const logged = await api("/login", { method: "POST", body: { username: user.username, password: "test-review-password" } });
  const token = logged.data.token;
  assert.deepEqual((await api("/my/activity-projects", { token })).data.projects, []);
  const mine = await api("/my/activity-projects", { method: "POST", token, body: { title: "审核演示素材" } });
  assert.equal(mine.status, 201);
  const list = await api("/my/activity-projects", { token });
  assert.deepEqual(list.data.projects.map(p => p.id), [mine.data.project.id]);
  assert.equal(list.data.projects[0].canManage, true);
  const granted = await api(`/admin/users/${user.id}`, { method: "PUT", token: adminToken,
    body: { albumReadScope: "own-and-selected", albumReadProjectIds: ["project_selected", "project_own", "project_selected"] } });
  assert.equal(granted.status, 200);
  const newer = await api("/login", { method: "POST", body: { username: user.username, password: "test-review-password" } });
  assert.equal((await api(`/admin/users/${user.id}`, { method: "PUT", token: adminToken,
    body: { albumReadScope: "own-and-selected", albumReadProjectIds: ["project_own", "project_selected"] } })).status, 200);
  assert.equal((await api("/me", { token: newer.data.token })).data.user.id, user.id, "白名单排序/去重不改变权限，不撤销会话");
}, { extraSeed: albumScopeFixture() }));

const onboardBody = code => ({ code, name: "新社群主理人", contact: "13900000000", organization: "上海摄影社群", city: "上海", agreed: true });

test("自助开通并发只创建一个无密码普通账号，默认仅本人相册且资料下载后置", () => withServer(async ({ api, adminToken, persisted }) => {
  const requests = await Promise.all(["applicant1", "applicant2"].map(code => api("/auth/wechat/onboard", { method: "POST", body: {
    ...onboardBody(code), userId: "renewal_owner", openid: "openid-conflict", role: "admin", canDownload: true, albumReadScope: "all"
  } })));
  for (const result of requests) assert.equal(result.status, 200);
  const { user, token } = requests[0].data;
  assert.equal(requests[1].data.user.id, user.id);
  assert.equal(user.role, "member"); assert.equal(user.status, "active");
  assert.equal(user.canDownload, false); assert.equal(user.associationStatus, "pending");
  for (const key of ["openid", "contact", "applicationContact", "passwordHash", "salt"]) assert.equal(user[key], undefined);
  const docs = persisted().users.map(row => JSON.parse(row.doc)).filter(item => item.authSource === "wechat-selfservice");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].passwordHash, null); assert.equal(docs[0].associationRevision, 1);
  assert.equal(docs[0].albumReadScope, "own-and-selected"); assert.deepEqual(docs[0].albumReadProjectIds, []);
  assert.equal(docs[0].applicationOrganization, "上海摄影社群");
  const retry = await api("/auth/wechat/onboard", { method: "POST", body: { ...onboardBody("applicant3"), name: "不能覆盖姓名" } });
  assert.equal(retry.data.user.name, user.name);
  assert.deepEqual((await api("/my/activity-projects", { token })).data.projects, []);
  const mine = await api("/my/activity-projects", { method: "POST", token, body: { title: "我的相册" } });
  assert.equal(mine.status, 201); assert.equal(mine.data.project.canManage, true);
  assert.equal((await api("/my/activity-projects/project_hidden", { token })).status, 404);
  assert.equal((await api("/public/activity-projects/project_shared", { token })).status, 200);
  for (const suffix of ["download", "download.pdf"]) {
    const denied = await api(`/public/activities/act_download_test/${suffix}`, { token });
    assert.equal(denied.status, 403); assert.match(denied.data.error, /总部.*关联审核/);
  }
  assert.equal((await api("/admin/account-reviews", { token })).status, 403);
  assert.equal((await api("/admin/account-reviews")).status, 401);
  assert.equal((await api("/admin/account-reviews", { token: adminToken })).status, 200);
}, { extraSeed: albumScopeFixture() }));

test("自助开通校验同意和资料，旧待审拒绝撤销停用身份均不得重开", async () => {
  await withServer(async ({ api, persisted }) => {
    for (const patch of [{ agreed: false }, { agreed: "true" }, { name: "一" }, { contact: "12345" }, { organization: " " }, { city: "城".repeat(81) }]) {
      assert.equal((await api("/auth/wechat/onboard", { method: "POST", body: { ...onboardBody("applicant1"), ...patch } })).status, 400);
    }
    assert.equal((persisted().wechat_identities || []).length, 0);
    await api("/auth/wechat/apply", { method: "POST", body: onboardBody("applicant1") });
    assert.equal((await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant2") })).status, 403);
  });
  for (const state of [{ bindingStatus: "rejected" }, { bindingStatus: "revoked" }, { status: "disabled" }, { suspended: true }]) {
    await withServer(async ({ api }) => {
      const denied = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("conflict") });
      assert.equal(denied.status, 403); assert.equal(denied.data.token, undefined);
    }, { extraSeed: renewalFixture(state) });
  }
});

test("关联审批CAS只处理一次、关联原账号仅作记录，原会话即时读新权限", () => withServer(async ({ api, adminToken, persisted }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  assert.equal(opened.status, 200);
  const { user, token } = opened.data;
  const list = await api("/admin/account-reviews", { token: adminToken });
  const review = list.data.reviews.find(item => item.kind === "association" && item.id === user.id);
  assert.equal(review.version, 1); assert.equal(review.status, "pending");
  assert.equal(review.contact, "13900000000");
  assert.equal(list.data.managers.some(item => item.id === "test_admin"), true);
  assert.equal(list.data.managers.some(item => item.id === "renewal_owner"), true);
  const route = `/admin/account-reviews/association/${user.id}/decision`;
  for (const patch of [{ managerId: user.id }, { managerId: "missing" }, { relatedAccountId: "test_admin" }, { relatedAccountId: user.id }]) {
    assert.equal((await api(route, { method: "POST", token: adminToken, body: { action: "approve", version: 1, ...patch } })).status, 409);
  }
  const outcomes = await Promise.all(["approve", "reject"].map(action => api(route, { method: "POST", token: adminToken,
    body: { action, version: 1, organization: "核实摄影社群", managerId: "test_admin", relatedAccountId: "renewal_owner", role: "admin", albumReadScope: "all" } })));
  assert.deepEqual(outcomes.map(item => item.status).sort(), [200, 409]);
  const current = (await api("/me", { token })).data.user;
  assert.equal(current.id, user.id); assert.equal(current.role, "member");
  const stored = JSON.parse(persisted().users.find(row => row.id === user.id).doc);
  assert.equal(stored.associationRevision, 2); assert.equal(stored.status, "active");
  assert.equal(stored.associationReviewedBy, "test_admin");
  assert.equal(current.canDownload, current.associationStatus === "approved");
  assert.deepEqual(stored.albumReadProjectIds, []);
  if (current.associationStatus === "approved") {
    assert.equal(stored.relatedAccountId, "renewal_owner");
    assert.equal(current.associatedManagerName, "测试总部");
    assert.equal((await api("/public/activities/act_download_test/download", { token })).status, 200);
  }
  assert.equal((await api("/my/activity-projects/project_own", { token })).status, 404);
  assert.equal(JSON.parse(persisted().activity_projects.find(row => row.id === "project_own").doc).ownerId, "renewal_owner");
}, { extraSeed: albumScopeFixture() }));

test("总部拒绝关联不撤销普通账号，通用下载授权不能绕过未关联检查", () => withServer(async ({ api, adminToken }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  assert.equal(opened.status, 200);
  const { user, token } = opened.data;
  const reject = await api(`/admin/account-reviews/association/${user.id}/decision`, { method: "POST", token: adminToken,
    body: { action: "reject", version: 1, note: "请总部线下核实" } });
  assert.equal(reject.status, 200);
  assert.equal((await api("/me", { token })).data.user.associationStatus, "rejected");
  assert.equal((await api("/my/activity-projects", { method: "POST", token, body: { title: "拒绝后仍可管理" } })).status, 201);
  await api(`/admin/users/${user.id}`, { method: "PUT", token: adminToken, body: { canDownload: true } });
  const logged = await api("/auth/wechat/session", { method: "POST", body: { code: "applicant2" } });
  assert.equal(logged.status, 200);
  assert.equal((await api("/public/activities/act_download_test/download", { token: logged.data.token })).status, 403);
}));

test("自助重提已绑定账号保留userId角色下载权限与相册", () => withServer(async ({ api, persisted }) => {
  const result = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("conflict") });
  assert.equal(result.status, 200); assert.equal(result.data.user.id, "renewal_owner");
  assert.equal(result.data.user.role, "operator"); assert.equal(result.data.user.canDownload, true);
  assert.equal(result.data.user.name, "续登主理人");
  assert.equal(JSON.parse(persisted().users.find(row => row.id === "renewal_owner").doc).associationStatus, undefined);
  assert.equal((await api("/my/activity-projects/project_own", { token: result.data.token })).status, 200);
}, { extraSeed: albumScopeFixture() }));

test("统一审核兼容旧微信与平台申请、版本冲突且普通流程不授予管理员", () => withServer(async ({ api, adminToken }) => {
  await api("/auth/wechat/apply", { method: "POST", body: onboardBody("applicant1") });
  await api("/register", { method: "POST", body: { ...onboardBody("existing1"), username: "legacy-review", password: "legacy-password" } });
  const list = (await api("/admin/account-reviews", { token: adminToken })).data;
  assert.ok(Array.isArray(list.reviews));
  const wechat = list.reviews.find(item => item.kind === "wechat" && item.status === "pending");
  const platform = list.reviews.find(item => item.kind === "platform" && item.status === "pending");
  for (const item of [wechat, platform]) {
    assert.ok(item.version); assert.equal(item.name, "新社群主理人"); assert.equal(item.contact, "13900000000");
    const route = `/admin/account-reviews/${item.kind}/${item.id}/decision`;
    const approved = await api(route, { method: "POST", token: adminToken,
      body: { action: "approve", version: item.version, role: "admin", canDownload: true, confirmNoExistingAccount: true } });
    assert.equal(approved.status, 200); assert.notEqual(approved.data.user.role, "admin");
    assert.equal((await api(route, { method: "POST", token: adminToken, body: { action: "reject", version: item.version } })).status, 409);
  }
  assert.equal((await api("/login", { method: "POST", body: { username: "legacy-review", password: "legacy-password" } })).status, 200);
}));

test("关联批准重新核实停用引用及排队期间被撤销的审核人", () => withServer(async ({ api, adminToken }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  assert.equal(opened.status, 200);
  const route = `/admin/account-reviews/association/${opened.data.user.id}/decision`;
  await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken, body: { status: "disabled" } });
  for (const patch of [{ managerId: "renewal_owner" }, { relatedAccountId: "renewal_owner" }]) {
    assert.equal((await api(route, { method: "POST", token: adminToken, body: { action: "approve", version: 1, ...patch } })).status, 409);
  }
  const created = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "second-reviewer", password: "admin-password", role: "admin" } });
  const second = await api("/login", { method: "POST", body: { username: "second-reviewer", password: "admin-password" } });
  await api(`/admin/users/${created.data.user.id}`, { method: "PUT", token: adminToken, body: { role: "viewer" } });
  assert.equal((await api(route, { method: "POST", token: second.data.token, body: { action: "approve", version: 1 } })).status, 401);
  assert.equal((await api("/me", { token: opened.data.token })).data.user.associationStatus, "pending");
}, { extraSeed: renewalFixture() }));

test("关联批准可用原会话下载资料，公开分享照片视频保存沿用旧规则", () => {
  const seed = albumScopeFixture();
  const project = JSON.parse(seed.activity_projects.find(row => row.id === "project_shared").doc);
  project.media = [{ type: "image", url: "https://proj2.likeduoduiyi.cn/silver-images/test.jpg" },
    { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/test.mp4" }];
  seed.activity_projects.find(row => row.id === project.id).doc = JSON.stringify(project);
  const item = { id: "case_onboard", title: "受限资料", status: "published", media: project.media, createdAt: new Date().toISOString() };
  seed.cases = [{ id: item.id, status: item.status, doc: JSON.stringify(item), created_at: item.createdAt }];
  return withServer(async ({ api, adminToken }) => {
    const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
    assert.equal(opened.status, 200);
    const { user, token } = opened.data;
    for (const index of [0, 1]) {
      const denied = await api(`/public/cases/${item.id}/download?i=${index}&format=json`, { token });
      assert.equal(denied.status, 403); assert.match(denied.data.error, /总部.*关联审核/);
      for (const session of [undefined, token]) {
        const allowed = await api(`/public/activity-projects/${project.id}/download?i=${index}`, { token: session });
        assert.equal(allowed.status, 200); assert.equal(allowed.data.url, project.media[index].url);
      }
    }
    const approved = await api(`/admin/account-reviews/association/${user.id}/decision`, { method: "POST", token: adminToken,
      body: { action: "approve", version: 1, relatedAccountId: "renewal_owner" } });
    assert.equal(approved.status, 200);
    const current = (await api("/me", { token })).data.user;
    assert.equal(current.associationStatus, "approved"); assert.equal(current.canDownload, true);
    assert.equal(current.associatedOrganization, "上海摄影社群"); assert.equal(current.associatedManagerId, "test_admin");
    assert.equal((await api(`/public/cases/${item.id}/download?i=0&format=json`, { token })).status, 200);
    assert.equal((await api("/public/activities/act_download_test/download", { token })).status, 200);
    assert.equal((await api("/my/activity-projects/project_own", { token })).status, 404);
    await api("/admin/users/renewal_owner", { method: "PUT", token: adminToken, body: { canDownload: false } });
    const legacy = await api("/login", { method: "POST", body: { username: "renewal-owner", password: "fixture-password" } });
    assert.equal((await api(`/public/cases/${item.id}/download?i=0&format=json`, { token: legacy.data.token })).status, 200,
      "旧账户案例下载仍只要求登录，不增加原本不存在的下载权限门槛");
  }, { extraSeed: seed });
});

test("审核排队后重新验证审核员权限，停用引用的写入不能被旧快照绕过", () => withServer(async ({ api, adminToken, gate }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  assert.equal(opened.status, 200);
  const reviewer = await api("/admin/users", { method: "POST", token: adminToken,
    body: { username: "queued-reviewer", password: "review-password", role: "admin" } });
  const logged = await api("/login", { method: "POST", body: { username: "queued-reviewer", password: "review-password" } });
  const boundary = gate("DELETE FROM sessions");
  const hold = api("/login", { method: "POST", body: { username: "test-admin", password: "test-password" } });
  await boundary.entered();
  const demote = api(`/admin/users/${reviewer.data.user.id}`, { method: "PUT", token: adminToken, body: { role: "viewer" } });
  await sleep(30);
  const decision = api(`/admin/account-reviews/association/${opened.data.user.id}/decision`, { method: "POST", token: logged.data.token,
    body: { action: "approve", version: 1 } });
  await sleep(30);
  boundary.release();
  const [, changed, denied] = await Promise.all([hold, demote, decision]);
  assert.equal(changed.status, 200); assert.equal(denied.status, 403);
  assert.equal((await api("/me", { token: opened.data.token })).data.user.associationStatus, "pending");
}));


test("总部重开仅将已拒绝业务关联改为新待审版本，再独立批准且不动微信身份相册权限", () => withServer(async ({ api, adminToken, persisted }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  const { user, token } = opened.data;
  const mine = await api("/my/activity-projects", { method: "POST", token, body: { title: "重开前相册" } });
  const route = `/admin/account-reviews/association/${user.id}/decision`;
  const decide = (action, version, patch = {}) => api(route, { method: "POST", token: adminToken, body: { action, version, ...patch } });
  assert.equal((await decide("reopen", 1)).status, 409, "待审不能重开");
  assert.equal((await decide("reject", 1)).status, 200);
  const identities = persisted().wechat_identities;
  const before = JSON.parse(persisted().users.find(row => row.id === user.id).doc);
  assert.equal((await decide("reopen", 1)).status, 409);
  assert.equal((await api(route, { method: "POST", token, body: { action: "reopen", version: 2 } })).status, 403);
  assert.equal((await decide("reopen", 2)).status, 200);
  const after = JSON.parse(persisted().users.find(row => row.id === user.id).doc);
  assert.equal(after.associationRevision, 3); assert.equal(after.associationStatus, "pending"); assert.equal(after.canDownload, false);
  for (const key of ["id", "role", "status", "albumReadScope", "albumReadProjectIds", "passwordHash", "sessionRevokedAt", "wechatBindingSuspended"]) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(persisted().wechat_identities, identities);
  assert.equal((await api(`/my/activity-projects/${mine.data.project.id}`, { token })).status, 200);
  assert.equal((await api("/public/activities/act_download_test/download", { token })).status, 403);
  assert.equal((await decide("reopen", 2)).status, 409); assert.equal((await decide("reopen", 3)).status, 409);
  for (const version of [1, 2]) assert.equal((await decide("approve", version)).status, 409);
  for (const patch of [{ managerId: "missing" }, { relatedAccountId: "test_admin" }, { organization: "" }]) assert.ok([400, 409].includes((await decide("approve", 3, patch)).status));
  assert.equal((await decide("approve", 3, { relatedAccountId: "renewal_owner" })).status, 200);
  assert.equal((await api("/public/activities/act_download_test/download", { token })).status, 200);
  assert.equal((await decide("reopen", 4)).status, 409);
  assert.equal((await decide("approve", 3)).status, 409);
  assert.equal(JSON.parse(persisted().activity_projects.find(row => row.id === "project_own").doc).ownerId, "renewal_owner");
  assert.equal((await api("/my/activity-projects/project_own", { token })).status, 404);
}, { extraSeed: albumScopeFixture() }));

test("账号维护停用再启用使旧关联审核卡失效，当前版本仍可批准", () => withServer(async ({ api, adminToken }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  const id = opened.data.user.id;
  const getReview = async () => (await api("/admin/account-reviews", { token: adminToken })).data.reviews.find(row => row.id === id && row.kind === "association");
  const before = await getReview();
  for (const status of ["disabled", "active"]) assert.equal((await api(`/admin/users/${id}`, { method: "PUT", token: adminToken, body: { status, canDownload: false } })).status, 200);
  const decision = version => api(`/admin/account-reviews/association/${id}/decision`, { method: "POST", token: adminToken, body: { action: "approve", version } });
  assert.equal((await decision(before.version)).status, 409, "disable→active ABA cannot revive an old card");
  let current = await getReview(); assert.ok(current.version > before.version);
  for (const patch of [{ name: "已复核姓名" }, { role: "viewer" }, { canDownload: true }, { albumReadScope: "all" }, { password: "new-password" }]) {
    const oldVersion = current.version;
    assert.equal((await api(`/admin/users/${id}`, { method: "PUT", token: adminToken, body: patch })).status, 200);
    assert.equal((await decision(oldVersion)).status, 409);
    current = await getReview(); assert.ok(current.version > oldVersion);
  }
  assert.equal((await decision(current.version)).status, 200);
}));

test("业务关联重开拒绝停用账号且统一接口不将其他来源reopen误当reject", () => withServer(async ({ api, adminToken }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  const id = opened.data.user.id;
  const route = `/admin/account-reviews/association/${id}/decision`;
  assert.equal((await api(route, { method: "POST", token: adminToken, body: { action: "reject", version: 1 } })).status, 200);
  await api(`/admin/users/${id}`, { method: "PUT", token: adminToken, body: { status: "disabled" } });
  const reviews = (await api("/admin/account-reviews", { token: adminToken })).data.reviews;
  const current = reviews.find(row => row.kind === "association");
  assert.equal((await api(route, { method: "POST", token: adminToken, body: { action: "reopen", version: current.version } })).status, 409);
  await api("/auth/wechat/apply", { method: "POST", body: onboardBody("existing1") });
  await api("/register", { method: "POST", body: { ...onboardBody("existing1"), username: "keep-platform", password: "platform-password" } });
  const legacy = (await api("/admin/account-reviews", { token: adminToken })).data.reviews.filter(row => row.kind !== "association");
  for (const row of legacy) {
    assert.equal((await api(`/admin/account-reviews/${row.kind}/${row.id}/decision`, { method: "POST", token: adminToken, body: { action: "reopen", version: row.version } })).status, 400);
  }
  const latest = (await api("/admin/account-reviews", { token: adminToken })).data.reviews;
  for (const row of legacy) assert.equal(latest.find(item => item.kind === row.kind && item.id === row.id).status, row.status);
}));

test("统一审核按实际来源保留独立同联系方式H5和绑定H5，只排除纯微信新建平台行", () => withServer(async ({ api, adminToken }) => {
  await api("/auth/wechat/apply", { method: "POST", body: onboardBody("applicant1") });
  let queue = (await api("/admin/account-reviews", { token: adminToken })).data.reviews;
  const wx = queue.find(row => row.kind === "wechat");
  const created = await api(`/admin/account-reviews/wechat/${wx.id}/decision`, { method: "POST", token: adminToken, body: { action: "approve", version: wx.version, confirmNoExistingAccount: true } });
  for (const username of ["h5-independent", "h5-bound"]) assert.equal((await api("/register", { method: "POST", body: { ...onboardBody("existing1"), username, password: "platform-password" } })).status, 201);
  queue = (await api("/admin/account-reviews", { token: adminToken })).data.reviews;
  const bound = queue.find(row => row.kind === "platform" && row.user.username === "h5-bound");
  await api("/auth/wechat/apply", { method: "POST", body: onboardBody("existing1") });
  queue = (await api("/admin/account-reviews", { token: adminToken })).data.reviews;
  const pending = queue.find(row => row.kind === "wechat" && row.status === "pending");
  assert.equal((await api(`/admin/account-reviews/wechat/${pending.id}/decision`, { method: "POST", token: adminToken, body: { action: "approve", version: pending.version, userId: bound.id } })).status, 200);
  queue = (await api("/admin/account-reviews", { token: adminToken })).data.reviews;
  const platforms = queue.filter(row => row.kind === "platform");
  assert.deepEqual(platforms.map(row => row.user.username).sort(), ["h5-bound", "h5-independent"]);
  assert.equal(platforms.every(row => row.contact === "13900000000"), true);
  assert.equal(queue.filter(row => row.kind === "wechat").length, 2);
  assert.equal(queue.some(row => row.kind === "platform" && row.userId === created.data.user.id), false);
}));


test("微信解绑和重新核实绑定递增业务审核版本，业务重开不恢复已撤销身份", () => withServer(async ({ api, adminToken, persisted }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  const id = opened.data.user.id;
  const decision = (action, version) => api(`/admin/account-reviews/association/${id}/decision`, { method: "POST", token: adminToken, body: { action, version } });
  const review = async () => (await api("/admin/account-reviews", { token: adminToken })).data.reviews.find(row => row.kind === "association" && row.id === id);
  assert.equal((await decision("reject", 1)).status, 200);
  const identity = persisted().wechat_identities.find(row => row.user_id === id);
  assert.equal((await api(`/admin/wechat/applications/${identity.id}/revoke`, { method: "POST", token: adminToken, body: {} })).status, 200);
  const revokedVersion = (await review()).version;
  assert.ok(revokedVersion > 2, "identity revocation invalidates association cards");
  const revoked = persisted().wechat_identities.find(row => row.id === identity.id);
  const securityBefore = JSON.parse(persisted().users.find(row => row.id === id).doc);
  assert.equal((await decision("reopen", 2)).status, 409);
  assert.equal((await decision("reopen", revokedVersion)).status, 200);
  assert.deepEqual(persisted().wechat_identities.find(row => row.id === identity.id), revoked);
  const securityAfter = JSON.parse(persisted().users.find(row => row.id === id).doc);
  assert.equal(securityAfter.sessionRevokedAt, securityBefore.sessionRevokedAt);
  assert.equal((await api("/auth/wechat/session", { method: "POST", body: { code: "applicant2" } })).data.status, "revoked");
  assert.equal((await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant3") })).status, 403);
  // The existing dedicated identity reopen remains a separate explicit HQ step.
  assert.equal((await api(`/admin/wechat/applications/${identity.id}/reopen`, { method: "POST", token: adminToken, body: {} })).status, 200);
  const beforeBinding = (await review()).version;
  assert.equal((await api(`/admin/wechat/applications/${identity.id}/approve`, { method: "POST", token: adminToken, body: { userId: id } })).status, 200);
  assert.equal((await decision("approve", beforeBinding)).status, 409);
  assert.equal((await decision("approve", (await review()).version)).status, 200);
}));

test("密码验证微信绑定提交后使旧业务审核版本失效且新版本可批准", () => withServer(async ({ api, adminToken }) => {
  const opened = await api("/auth/wechat/onboard", { method: "POST", body: onboardBody("applicant1") });
  const id = opened.data.user.id;
  assert.equal((await api(`/admin/users/${id}`, { method: "PUT", token: adminToken, body: { password: "bind-password" } })).status, 200);
  const review = async () => (await api("/admin/account-reviews", { token: adminToken })).data.reviews.find(row => row.id === id && row.kind === "association");
  const before = await review();
  assert.equal((await api("/auth/wechat/bind", { method: "POST", body: { code: "applicant2", username: opened.data.user.username, password: "bind-password" } })).status, 200);
  const decision = version => api(`/admin/account-reviews/association/${id}/decision`, { method: "POST", token: adminToken, body: { action: "approve", version } });
  assert.equal((await decision(before.version)).status, 409);
  assert.equal((await decision((await review()).version)).status, 200);
}));
