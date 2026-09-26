const test = require("node:test");
const assert = require("node:assert/strict");
const { SESSION_KEY } = require("../utils/auth");

function pageAt(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
}

test("普通启动直接显示登录表单，旧分享编号仍直接进匿名相册", async () => {
  const redirects = [];
  global.wx = { getStorageSync: () => null, redirectTo: value => redirects.push(value.url) };
  const entry = pageAt("../pages/entry/index.js");
  await entry.onLoad({});
  assert.equal(entry.data.loading, false);
  assert.deepEqual(redirects, []);
  await entry.onLoad({ id: "project_85aae4b746069044" });
  assert.deepEqual(redirects, ["/pages/album/index?id=project_85aae4b746069044"]);
  delete global.wx;
});

test("只读账号可以看到全部活动相册，但没有新建和管理入口", async () => {
  const calls = [];
  const storage = new Map([[SESSION_KEY, { token: "test-token", user: { role: "viewer" } }]]);
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), redirectTo: value => calls.push(value.url),
    navigateTo: value => calls.push(value.url),
    request(options) {
      calls.push(options.url);
      const data = options.url.endsWith("/me") ? { user: { role: "viewer", name: "资料账号" } }
        : options.url.endsWith("/my/activity-projects") ? { projects: [{ id: "project_85aae4b746069044", title: "别人的相册", media: [], canManage: false }], canCreate: false }
        : options.url.endsWith("/public/activities") ? { activities: [{ id: "act_001", title: "肖像美拍" }] }
          : { cases: [] };
      options.success({ statusCode: 200, data });
    }
  };
  const workbench = pageAt("../pages/workbench/index.js");
  await workbench.load();
  assert.equal(workbench.data.canCreateProjects, false);
  assert.equal(workbench.data.tab, "projects");
  assert.equal(workbench.data.projects.length, 1);
  assert.equal(workbench.data.projects[0].canManage, false);
  assert.equal(workbench.data.visibleActivities.length, 1);
  assert.equal(calls.some(value => String(value).includes("/my/activity-projects")), true);
  workbench.onCreateOpen();
  assert.equal(workbench.data.creating, false);
  workbench.onManage({ currentTarget: { dataset: { id: "project_85aae4b746069044" } } });
  assert.equal(calls.at(-1), "/pages/manage/index?id=project_85aae4b746069044");
  delete global.wx;
});
