const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPage(filename, exports) {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
  const context = vm.createContext({
    document: { querySelector: () => ({}), querySelectorAll: () => [], addEventListener() {} },
    location: { hostname: "localhost" },
    window: { location: { origin: "http://localhost" }, addEventListener() {} },
    localStorage: { getItem: () => null },
    URL, URLSearchParams, Set, console
  });
  vm.runInContext(source.replace(/^boot\(\);$/m, "") + `\nglobalThis.page = { ${exports.join(", ")} };`, context);
  return context;
}

function element(initial = {}) {
  const handlers = {};
  return Object.assign({
    value: "", checked: false, disabled: false, hidden: false, textContent: "", handlers,
    addEventListener(event, handler) { handlers[event] = handler; }
  }, initial);
}

test("H5 申请引导沿用原账号；未授权 SOP 下载没有可点击的导出入口", () => {
  const context = loadPage("app.js", ["state", "loginModal", "tabSop"]);
  context.page.state.loginOpen = true;
  context.page.state.authTab = "register";
  const application = context.page.loginModal();
  assert.match(application, /已有账号请直接登录/);
  assert.match(application, /总部核实开通/);
  assert.doesNotMatch(application, /name="role"|name="canDownload"/);
  context.page.state.user = { role: "viewer", canDownload: false };
  const denied = context.page.tabSop({ plan: {}, downloadEnabled: true });
  assert.match(denied, /未开通 SOP 下载权限/);
  assert.doesNotMatch(denied, /id="downloadSopBtn"|data-open-login/);
  context.page.state.user.canDownload = true;
  assert.match(context.page.tabSop({ plan: {}, downloadEnabled: true }), /id="downloadSopBtn"/);
});

test("总部相册范围控件：旧账号默认全部，受限账号只勾选指定相册并转义内容", () => {
  const context = loadPage("admin.js", ["state", "albumReadFieldsHtml", "userCardHtml"]);
  context.page.state.activityProjects = [
    { id: "project_demo", title: "演示相册 <script>", ownerName: "主办方", city: "北京" },
    { id: "project_other", title: "另一相册" }
  ];
  context.page.state.user = { id: "u_hq" };
  const legacy = context.page.albumReadFieldsHtml({ role: "member" });
  assert.match(legacy, /value="all" selected/);
  assert.match(legacy, /data-album-projects hidden/);
  assert.match(legacy, /分享链接.*单个相册/);
  const limited = context.page.albumReadFieldsHtml({ role: "member", albumReadScope: "own-and-selected", albumReadProjectIds: ["project_demo", "project_deleted"] });
  assert.match(limited, /value="own-and-selected" selected/);
  assert.match(limited, /value="project_demo" checked/);
  assert.doesNotMatch(limited, /value="project_other" checked/);
  assert.match(limited, /演示相册 &lt;script&gt;/);
  assert.match(limited, /1 条已失效相册授权/);
  assert.match(context.page.userCardHtml({ id: "u_review", username: "review", role: "member", albumReadScope: "own-and-selected", albumReadProjectIds: ["project_demo"] }), /本人创建及指定相册（1 个指定）/);
});

function albumScopeForm(roleValue, scopeValue, checkedIds) {
  const role = element({ value: roleValue });
  const scope = element({ value: scopeValue });
  const list = element();
  const container = {
    querySelector(selector) {
      return selector === "[data-album-read-scope]" ? scope
        : selector === "[data-u-role], [name='role']" ? role
        : selector === "[data-album-projects]" ? list : null;
    },
    querySelectorAll(selector) { return selector === "[data-album-project]:checked" ? checkedIds.map(value => ({ value })) : []; }
  };
  return { container, role, scope, list };
}

test("相册范围提交：限制查看仅提交勾选IDs，全部/总部不保留隐含授权", () => {
  const context = loadPage("admin.js", ["albumReadFieldsValue", "syncAlbumReadFields"]);
  const fixture = albumScopeForm("member", "own-and-selected", ["project_demo", "project_demo"]);
  const value = () => JSON.parse(JSON.stringify(context.page.albumReadFieldsValue(fixture.container)));
  assert.deepEqual(value(), { albumReadScope: "own-and-selected", albumReadProjectIds: ["project_demo"] });
  context.page.syncAlbumReadFields(fixture.container);
  assert.equal(fixture.scope.disabled, false);
  assert.equal(fixture.list.hidden, false);
  fixture.scope.value = "all";
  assert.deepEqual(value(), { albumReadScope: "all", albumReadProjectIds: [] });
  context.page.syncAlbumReadFields(fixture.container);
  assert.equal(fixture.list.hidden, true);
  fixture.scope.value = "own-and-selected";
  fixture.role.value = "admin";
  assert.deepEqual(value(), { albumReadScope: "all", albumReadProjectIds: [] });
  context.page.syncAlbumReadFields(fixture.container);
  assert.equal(fixture.scope.disabled, true);
  assert.equal(fixture.list.hidden, true);
});

test("新建和编辑账号共享相册范围控件，选择行为即时更新，不设审核绕过", () => {
  const context = loadPage("admin.js", ["state", "renderUsers", "bindUserEvents"]);
  const content = { innerHTML: "" };
  const fixture = albumScopeForm("member", "all", []);
  context.page.state.user = { id: "u_hq" };
  context.page.state.usersView = "accounts";
  context.page.state.users = [{ id: "u_member", username: "member", role: "member", name: "主办方", status: "active" }];
  context.document.querySelector = selector => selector === "#content" ? content : element();
  context.document.querySelectorAll = selector => selector === "[data-album-scope-form]" ? [fixture.container] : [];
  context.page.renderUsers();
  assert.equal((content.innerHTML.match(/data-album-scope-form/g) || []).length, 2);
  assert.match(content.innerHTML, /活动相册查看范围/);
  assert.match(content.innerHTML, /仅本人创建及总部指定/);
  fixture.scope.value = "own-and-selected";
  fixture.scope.handlers.change();
  assert.equal(fixture.list.hidden, false);
  fixture.role.value = "admin";
  fixture.role.handlers.change();
  assert.equal(fixture.scope.disabled, true);
  assert.equal(fixture.list.hidden, true);
});

// Breaks caught: missing unified review handlers, incorrect revision/payload,
// re-submission of stale cards, unsafe interpolation, and lost legacy guards.
function unifiedFixture(kind = "association", version = 3) {
  const context = loadPage("admin.js", ["state", "renderUsers", "bindUserEvents", "refreshData"]);
  const review = { kind, id: "r/<one>", userId: "u_new", name: "王老师<script>", contact: '138"<img>', city: "北京", organization: '书画社"<svg>', status: "pending", version, submittedAt: "2026-11-02", permissions: { role: "member", accountStatus: "active", canDownload: false, albumReadScope: "own-and-selected", albumReadProjectIds: [] }, user: { id: "u_new", username: "wx_new", role: "member", status: "active" }, note: "<script>note</script>" };
  Object.assign(context.page.state, { user: { id: "u_hq", name: "总部", role: "admin" }, users: [{ id: "u_old", name: "原账号", username: "old", role: "operator", status: "active", canDownload: true }], accountReviews: [review], reviewManagers: [{ id: "u_hq", name: "总部<script>", role: "admin" }], accountReviewView: "pending", usersView: "reviews", accountReviewsReady: true });
  const nodes = Object.fromEntries(["data-review-organization", "data-review-manager", "data-review-related", "data-review-note", "data-review-role", "data-review-download", "data-wx-target", "data-wx-role", "data-wx-download", "data-wx-confirm", "data-wx-new-confirm", "data-wx-approve", "data-wx-selection-note"].map(key => [`[${key}]`, element()]));
  nodes["[data-review-organization]"].value = "书画社";
  nodes["[data-review-manager]"].value = "u_hq";
  nodes["[data-review-related]"].value = "u_old";
  nodes["[data-review-note]"].value = "已核实";
  nodes["[data-review-role]"].value = "viewer";
  const card = { dataset: { reviewKind: kind, reviewId: review.id }, querySelector: selector => nodes[selector], querySelectorAll: () => [] };
  const approve = element({ dataset: { reviewAction: "approve" }, closest: () => card });
  const reject = element({ dataset: { reviewAction: "reject" }, closest: () => card });
  const retry = element();
  const content = element({ innerHTML: "" });
  context.document.querySelector = selector => selector === "#content" ? content : element();
  context.document.querySelectorAll = selector => selector === "[data-review-action]" ? [approve, reject] : selector === "[data-review-refresh]" ? [retry] : selector === "[data-wx-id]" && kind === "wechat" ? [card] : [];
  const requests = [], confirmations = [];
  let reviewsResponse = { reviews: [], managers: [{ id: "u_hq", name: "总部", role: "admin" }] };
  let postError = null, getError = null;
  context.confirm = message => { confirmations.push(message); return true; };
  context.api = async (url, options) => {
    requests.push({ url, options });
    if (options?.method === "POST") { if (postError) throw postError; return { ok: true }; }
    if (url === "/api/admin/account-reviews") { if (getError) throw getError; return reviewsResponse; }
    if (url === "/api/admin/users") return { users: context.page.state.users };
    return {};
  };
  const bind = () => { context.page.bindUserEvents(); assert.equal(typeof approve.handlers.click, "function", "unified approve action is bound"); };
  return { context, review, nodes, card, approve, reject, retry, content, requests, confirmations, bind, setReviews: value => { reviewsResponse = value; }, failPost: error => { postError = error; }, failGet: error => { getError = error; } };
}

test("统一队列渲染三种来源，资料与负责人转义；维护操作仅在次级页", () => {
  const f = unifiedFixture();
  f.context.page.state.accountReviews.push({ ...f.review, kind: "platform", id: "h5", name: "H5用户" }, { ...f.review, kind: "wechat", id: "wx", name: "微信用户" });
  f.context.page.renderUsers();
  assert.match(f.content.innerHTML, /王老师&lt;script&gt;/);
  assert.match(f.content.innerHTML, /H5用户/);
  assert.match(f.content.innerHTML, /微信用户/);
  assert.match(f.content.innerHTML, /待关联/);
  assert.match(f.content.innerHTML, /已开通/);
  assert.match(f.content.innerHTML, /已处理/);
  assert.match(f.content.innerHTML, /总部&lt;script&gt;/);
  assert.doesNotMatch(f.content.innerHTML, /<script>|<img>|<svg>|id="createUserForm"|data-save-user|批量通过/);
  f.context.page.state.usersView = "accounts";
  f.context.page.renderUsers();
  assert.match(f.content.innerHTML, /id="createUserForm"/);
  assert.match(f.content.innerHTML, /data-save-user="u_old"/);
});

test("普通关联通过发送原始数字版本和组织负责人，核实原账号不会附带权限或合并字段", async () => {
  const f = unifiedFixture(); f.bind();
  await f.approve.handlers.click();
  const post = f.requests.find(x => x.options?.method === "POST");
  assert.equal(post.url, "/api/admin/account-reviews/association/r%2F%3Cone%3E/decision");
  assert.deepEqual(JSON.parse(JSON.stringify(post.options.body)), { action: "approve", version: 3, organization: "书画社", managerId: "u_hq", relatedAccountId: "u_old", note: "已核实" });
  assert.equal(f.context.page.state.accountReviews.length, 0);
  assert.doesNotMatch(f.content.innerHTML, /data-review-id="r\//);
});

test("拒绝关联说明本人相册仍可用，未通过动作不允许重复发送", async () => {
  const f = unifiedFixture(); f.bind();
  await f.reject.handlers.click();
  assert.match(f.confirmations[0], /本人相册.*仍可用/);
  await f.reject.handlers.click();
  assert.equal(f.requests.filter(x => x.options?.method === "POST").length, 1);
  assert.equal(f.requests[0].options.body.action, "reject");
});

test("平台旧申请保留不透明版本及逐人授权", async () => {
  const f = unifiedFixture("platform", "legacy:opaque/1"); f.bind();
  f.nodes["[data-review-role]"].value = "operator";
  f.nodes["[data-review-download]"].checked = true;
  await f.approve.handlers.click();
  const body = f.requests[0].options.body;
  assert.equal(body.version, "legacy:opaque/1");
  assert.equal(body.role, "operator"); assert.equal(body.canDownload, true);
});

test("409版本冲突刷新卡片且保留提示，不重新提交旧版本", async () => {
  const f = unifiedFixture(); f.bind();
  f.failPost(Object.assign(new Error("版本已变化"), { status: 409 }));
  f.setReviews({ reviews: [{ ...f.review, version: 4, status: "approved" }], managers: [] });
  await f.approve.handlers.click();
  assert.equal(f.context.page.state.accountReviews[0].version, 4);
  assert.match(f.content.innerHTML, /版本已变化/);
  await f.approve.handlers.click();
  assert.equal(f.requests.filter(x => x.options?.method === "POST").length, 1);
});

test("审批后刷新失败隐藏旧卡片并提供恢复刷新，结果不误报失败或可重复提交", async () => {
  const f = unifiedFixture(); f.bind(); f.failGet(new Error("网络中断"));
  await f.approve.handlers.click();
  assert.equal(f.context.page.state.accountReviewsReady, false);
  assert.equal(f.context.page.state.accountReviews.length, 0);
  assert.match(f.content.innerHTML, /已提交.*刷新/);
  assert.match(f.content.innerHTML, /data-review-refresh/);
  await f.approve.handlers.click();
  assert.equal(f.requests.filter(x => x.options?.method === "POST").length, 1);
  f.failGet(null);
  await f.retry.handlers.click();
  assert.equal(f.context.page.state.accountReviewsReady, true);
});

test("微信旧申请仍人工选择绑定、冲突禁用、新建须确认；已启用原账号不发送权限", async () => {
  const f = unifiedFixture("wechat", "wx:v1"); f.bind();
  await f.approve.handlers.click();
  assert.equal(f.requests.length, 0);
  f.nodes["[data-wx-target]"].value = "__new__";
  f.nodes["[data-wx-target]"].handlers.change();
  await f.approve.handlers.click(); assert.equal(f.requests.length, 0);
  f.nodes["[data-wx-target]"].value = "u_old";
  f.nodes["[data-wx-target]"].handlers.change();
  f.nodes["[data-wx-role]"].value = "admin";
  f.nodes["[data-wx-download]"].checked = false;
  await f.approve.handlers.click();
  const body = f.requests[0].options.body;
  assert.equal(body.version, "wx:v1"); assert.equal(body.userId, "u_old");
  assert.equal(Object.hasOwn(body, "role"), false); assert.equal(Object.hasOwn(body, "canDownload"), false);
});

test("相同ID的新待审版本刷新后，旧卡片回调不能审批新版本", async () => {
  const f = unifiedFixture(); f.bind();
  const oldClick = f.approve.handlers.click;
  f.failPost(Object.assign(new Error("版本已变化"), { status: 409 }));
  f.setReviews({ reviews: [{ ...f.review, version: 4 }], managers: [{ id: "u_hq", name: "总部", role: "admin" }] });
  await oldClick();
  f.failPost(null);
  await oldClick();
  assert.equal(f.requests.filter(x => x.options?.method === "POST").length, 1, "old event must never use a refreshed revision");
});

test("同联系方式仅提示人工核实，原账号保持未选且只放详情", () => {
  const f = unifiedFixture();
  f.context.page.state.users[0].applicationContact = f.review.contact;
  f.context.page.renderUsers();
  assert.match(f.content.innerHTML, /同联系方式.*人工核实/);
  assert.doesNotMatch(f.content.innerHTML, /value="u_old" selected/);
  assert.match(f.content.innerHTML, /<details[\s\S]*data-review-related/);
  assert.match(f.content.innerHTML, /data-review-organization maxlength="120" value="书画社&quot;&lt;svg&gt;"/);
  assert.match(f.content.innerHTML, /value="u_hq" selected/);
});

test("旧微信候选和处理保留已绑定、停用、总部、迁移冲突限制，逐项授权待审与新建", async () => {
  const f = unifiedFixture("wechat", "wx:opaque");
  f.context.page.state.users.push(
    { id: "bound", username: "bound", name: "已绑定", role: "member", status: "active", wechatBinding: { fingerprint: "wx-code" } },
    { id: "off", username: "off", name: "停用", role: "member", status: "disabled" },
    { id: "hq", username: "hq", name: "总部", role: "admin", status: "active" },
    { id: "retired", username: "retired", name: "迁移", role: "member", status: "active", retiredToUserId: "u_old" },
    { id: "pending", username: "pending", name: "H5待审", role: "viewer", status: "pending" }
  );
  f.context.page.renderUsers();
  assert.match(f.content.innerHTML, /<option value="bound" disabled>/);
  for (const id of ["off", "hq", "retired"]) assert.equal(f.content.innerHTML.includes(`<option value="${id}"`), false);
  f.bind();
  for (const target of ["bound", "off", "hq", "retired"]) {
    f.nodes["[data-wx-target]"].value = target;
    f.nodes["[data-wx-target]"].handlers.change();
    assert.equal(f.nodes["[data-wx-approve]"].disabled, true);
    await f.approve.handlers.click();
    assert.equal(f.requests.length, 0);
  }
  f.nodes["[data-wx-target]"].value = "pending";
  f.nodes["[data-wx-target]"].handlers.change();
  f.nodes["[data-wx-role]"].value = "member";
  f.nodes["[data-wx-download]"].checked = true;
  await f.approve.handlers.click();
  assert.equal(f.requests[0].options.body.userId, "pending");
  assert.equal(f.requests[0].options.body.role, "member");
  assert.equal(f.requests[0].options.body.canDownload, true);
  const g = unifiedFixture("wechat", "new:v1"); g.bind();
  g.nodes["[data-wx-target]"].value = "__new__";
  g.nodes["[data-wx-target]"].handlers.change();
  assert.equal(g.nodes["[data-wx-role]"].value, "viewer");
  assert.equal(g.nodes["[data-wx-download]"].checked, false);
  g.nodes["[data-wx-confirm]"].checked = true;
  g.nodes["[data-wx-confirm]"].handlers.change();
  await g.approve.handlers.click();
  assert.equal(g.requests[0].options.body.userId, "");
  assert.equal(g.requests[0].options.body.confirmNoExistingAccount, true);
  assert.equal(g.requests[0].options.body.role, "viewer");
});

test("过滤器实际点击切换同一队列，不按姓名联系方式删除记录或使停用账号进入待审", async () => {
  const f = unifiedFixture();
  f.context.page.state.accountReviews.push({ ...f.review, id: "approved", status: "approved" }, { ...f.review, id: "rejected", status: "rejected" }, { ...f.review, id: "off", permissions: { ...f.review.permissions, accountStatus: "disabled" } });
  const filter = element({ dataset: { reviewView: "active" } });
  const queryAll = f.context.document.querySelectorAll;
  f.context.document.querySelectorAll = selector => selector === "[data-review-view]" ? [filter] : queryAll(selector);
  f.context.page.bindUserEvents();
  await filter.handlers.click();
  assert.equal(f.context.page.state.accountReviewView, "active");
  assert.match(f.content.innerHTML, /data-review-id="approved"/);
  assert.doesNotMatch(f.content.innerHTML, /data-review-id="rejected"|data-review-id="off"|data-review-action/);
  filter.dataset.reviewView = "processed";
  await filter.handlers.click();
  assert.match(f.content.innerHTML, /data-review-id="rejected"/);
  assert.match(f.content.innerHTML, /data-review-id="off"/);
  assert.doesNotMatch(f.content.innerHTML, /data-review-action/);
  assert.equal(f.context.page.state.accountReviews.length, 4);
});

test("请求未返回时重复点击只发送一次，普通组织或负责人缺失不会发起审核", async () => {
  const f = unifiedFixture(); f.bind();
  f.nodes["[data-review-organization]"].value = " ";
  await f.approve.handlers.click(); assert.equal(f.requests.length, 0);
  assert.match(f.content.innerHTML, /请填写/);
  f.nodes["[data-review-organization]"].value = "摄影社";
  f.nodes["[data-review-manager]"].value = "invalid";
  await f.approve.handlers.click(); assert.equal(f.requests.length, 0);
  f.nodes["[data-review-manager]"].value = "u_hq";
  let resolvePost;
  const api = f.context.api;
  f.context.api = async (url, options) => {
    if (options?.method === "POST") { f.requests.push({ url, options }); return new Promise(resolve => { resolvePost = resolve; }); }
    return api(url, options);
  };
  const click = f.approve.handlers.click();
  await f.approve.handlers.click();
  assert.equal(f.requests.filter(x => x.options?.method === "POST").length, 1);
  assert.equal(f.context.page.state.accountReviewBusy, true);
  resolvePost({ ok: true }); await click;
  assert.equal(f.context.page.state.accountReviewBusy, false);
});

test("初始刷新使用统一审核接口和负责人，不再请求独立微信队列", async () => {
  const f = unifiedFixture();
  f.setReviews({ reviews: [f.review], managers: [{ id: "u_hq", name: "总部", role: "admin" }] });
  await f.context.page.refreshData();
  assert.equal(f.requests.some(row => row.url === "/api/admin/account-reviews"), true);
  assert.equal(f.requests.some(row => row.url === "/api/admin/wechat/applications"), false);
  assert.equal(f.context.page.state.accountReviews[0].version, 3);
  assert.equal(f.context.page.state.reviewManagers[0].id, "u_hq");
});

test("审批刷新后侧栏待审数量同步，避免审核已消失但待办数仍保留", async () => {
  const f = unifiedFixture();
  const badge = element({ textContent: "1" });
  const query = f.context.document.querySelector;
  f.context.document.querySelector = selector => selector === "[data-account-review-count]" ? badge : query(selector);
  f.bind(); await f.approve.handlers.click();
  assert.equal(badge.textContent, "0");
  assert.equal(badge.hidden, true);
});

test("尚无平台账号的历史微信申请不会显示拥有全部相册权限", () => {
  const f = unifiedFixture("wechat", "unbound:1");
  f.review.permissions = null; f.review.user = null; f.review.userId = null;
  f.context.page.renderUsers();
  assert.match(f.content.innerHTML, /当前角色：未开通/);
  assert.match(f.content.innerHTML, /相册范围：未开通/);
  assert.doesNotMatch(f.content.innerHTML, /相册范围：全部相册/);
});
