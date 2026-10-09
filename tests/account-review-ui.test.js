const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPage(filename, exports) {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8");
  const context = vm.createContext({
    document: { querySelector: () => ({}), querySelectorAll: () => [] },
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

function adminFixture() {
  const context = loadPage("admin.js", ["state", "wechatApplicationsHtml", "wechatReviewSelection", "syncWechatReviewCard", "bindUserEvents", "renderUsers"]);
  const users = [
    { id: "u_original", username: "original", name: "原主办方", role: "operator", status: "active", canDownload: true },
    { id: "u_pending", username: "pending", name: "待审用户", role: "viewer", status: "pending", canDownload: false },
    { id: "u_bound", username: "bound", name: "已绑定用户", role: "member", status: "active", wechatBinding: { fingerprint: "code-bound" } },
    { id: "u_disabled", username: "disabled", name: "停用用户", role: "viewer", status: "disabled" },
    { id: "u_admin", username: "hq", name: "总部", role: "admin", status: "active" },
    { id: "u_retired", username: "retired", name: "已迁移用户", role: "operator", status: "active", retiredToUserId: "u_original" }
  ];
  context.page.state.users = users;
  context.page.state.user = users[4];
  context.page.state.wechatApplications = [{ id: "wx_pending", name: "申请人", status: "pending", contact: "13800000000", fingerprint: "code-pending" }];
  const nodes = Object.fromEntries([
    "data-wx-target", "data-wx-role", "data-wx-download", "data-wx-confirm", "data-wx-new-confirm", "data-wx-approve", "data-wx-selection-note"
  ].map(key => [`[${key}]`, element()]));
  nodes["[data-wx-approve]"].dataset = { wxApprove: "wx_pending" };
  const card = { dataset: {}, querySelector: selector => nodes[selector] };
  nodes["[data-wx-approve]"].closest = () => card;
  const createForm = element();
  context.document.querySelector = selector => selector === "#createUserForm" ? createForm : null;
  context.document.querySelectorAll = selector => selector === "[data-wx-id]" ? [card]
    : selector === "[data-wx-approve]" ? [nodes[selector]] : [];
  const requests = [];
  context.api = async (url, options) => { requests.push({ url, body: options.body }); return {}; };
  context.refreshData = async () => {};
  context.renderUsers = () => {};
  context.flash = () => {};
  context.confirm = () => true;
  return { context, card, nodes, requests };
}

test("后台候选账号展示身份、状态与绑定；已绑定禁选，总部和停用账号不进入普通匹配", () => {
  const { context } = adminFixture();
  const html = context.page.wechatApplicationsHtml();
  assert.match(html, /原主办方 · @original · 城市主理人 · 已启用 · 微信未绑定 · userId：u_original/);
  assert.match(html, /H5 待审.*userId：u_pending/);
  assert.match(html, /<option value="u_bound" disabled>.*code-bound/);
  for (const id of ["u_admin", "u_disabled", "u_retired"]) {
    assert.equal(html.includes(`<option value="${id}"`), false);
    assert.equal(context.page.wechatReviewSelection(id).canApprove, false);
  }
  assert.equal(context.page.wechatReviewSelection("u_bound").canApprove, false);
});

test("更换匹配对象时保留原账号权限，新建必须重新确认且默认只读无下载", () => {
  const { context, card, nodes } = adminFixture();
  context.page.bindUserEvents();
  assert.equal(nodes["[data-wx-approve]"].disabled, true);
  assert.equal(nodes["[data-wx-new-confirm]"].hidden, true);
  nodes["[data-wx-target]"].value = "u_original";
  nodes["[data-wx-target]"].handlers.change();
  assert.equal(nodes["[data-wx-role]"].value, "operator");
  assert.equal(nodes["[data-wx-role]"].disabled, true);
  assert.equal(nodes["[data-wx-download]"].checked, true);
  assert.equal(nodes["[data-wx-download]"].disabled, true);
  assert.match(nodes["[data-wx-selection-note]"].textContent, /userId：u_original/);
  nodes["[data-wx-target]"].value = "__new__";
  nodes["[data-wx-target]"].handlers.change();
  assert.equal(nodes["[data-wx-role]"].value, "viewer");
  assert.equal(nodes["[data-wx-role]"].disabled, false);
  assert.equal(nodes["[data-wx-download]"].checked, false);
  assert.equal(nodes["[data-wx-new-confirm]"].hidden, false);
  assert.equal(nodes["[data-wx-approve]"].disabled, true);
  nodes["[data-wx-confirm]"].checked = true;
  nodes["[data-wx-confirm]"].handlers.change();
  assert.equal(nodes["[data-wx-approve]"].disabled, false);
  nodes["[data-wx-target]"].value = "u_pending";
  context.page.syncWechatReviewCard(card);
  assert.equal(nodes["[data-wx-confirm]"].checked, false);
  assert.equal(nodes["[data-wx-new-confirm]"].hidden, true);
  assert.equal(nodes["[data-wx-role]"].disabled, false);
  assert.equal(nodes["[data-wx-download]"].disabled, false);
});

test("实际审批点击：绑定已启用账号不提交角色与下载字段，不因控件篡改改变原权限", async () => {
  const { context, nodes, requests } = adminFixture();
  context.page.bindUserEvents();
  nodes["[data-wx-target]"].value = "u_original";
  nodes["[data-wx-target]"].handlers.change();
  nodes["[data-wx-role]"].value = "admin";
  nodes["[data-wx-download]"].checked = false;
  await nodes["[data-wx-approve]"].handlers.click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.userId, "u_original");
  assert.equal(requests[0].body.confirmNoExistingAccount, false);
  assert.equal(Object.hasOwn(requests[0].body, "role"), false);
  assert.equal(Object.hasOwn(requests[0].body, "canDownload"), false);
});

test("实际审批点击：待审账号逐人授权，新建未经人工确认不能发送审批", async () => {
  const { context, nodes, requests } = adminFixture();
  context.page.bindUserEvents();
  nodes["[data-wx-target]"].value = "u_pending";
  nodes["[data-wx-target]"].handlers.change();
  nodes["[data-wx-role]"].value = "member";
  nodes["[data-wx-download]"].checked = true;
  await nodes["[data-wx-approve]"].handlers.click();
  assert.equal(requests[0].body.userId, "u_pending");
  assert.equal(requests[0].body.role, "member");
  assert.equal(requests[0].body.canDownload, true);
  nodes["[data-wx-target]"].value = "__new__";
  nodes["[data-wx-target]"].handlers.change();
  await nodes["[data-wx-approve]"].handlers.click();
  assert.equal(requests.length, 1);
  nodes["[data-wx-confirm]"].checked = true;
  await nodes["[data-wx-approve]"].handlers.click();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.userId, "");
  assert.equal(requests[1].body.confirmNoExistingAccount, true);
  assert.equal(requests[1].body.role, "viewer");
  assert.equal(requests[1].body.canDownload, false);
});

test("后台审核页不包含停用账号审批或批量通过入口", () => {
  const { context } = adminFixture();
  const content = { innerHTML: "" };
  context.document.querySelector = () => content;
  context.bindUserEvents = () => {};
  context.page.renderUsers();
  assert.match(content.innerHTML, /data-approve-user="u_pending"/);
  assert.doesNotMatch(content.innerHTML, /data-approve-user="u_disabled"/);
  assert.doesNotMatch(content.innerHTML, /全部通过|全部启用|批量通过/);
});

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
