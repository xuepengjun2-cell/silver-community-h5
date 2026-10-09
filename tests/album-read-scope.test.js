const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { identityError } = require("../server/wechat-identity");

// 只载入权限纯函数，不启动服务或接触数据库。HTTP 层由 wechat-identity-api 回归覆盖。
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const start = source.indexOf("function albumReadPolicy(");
const end = source.indexOf("function projectForAccount(", start);
assert.ok(start >= 0 && end > start);
const policy = { identityError };
vm.createContext(policy);
vm.runInContext(source.slice(start, end), policy);
const plain = value => JSON.parse(JSON.stringify(value));
const owned = { id: "project_own", ownerId: "user_a" };
const selected = { id: "project_selected", ownerId: "user_b" };
const hidden = { id: "project_hidden", ownerId: "user_b" };
const projects = [owned, selected, hidden];

test("相册读取：历史默认全部可见，总部始终全部可见，未知范围不扩大权限", () => {
  assert.equal(policy.projectCanRead({ id: "legacy", role: "member" }, hidden), true);
  assert.equal(policy.projectCanRead({ id: "hq", role: "admin", albumReadScope: "own-and-selected", albumReadProjectIds: [] }, hidden), true);
  assert.equal(policy.projectCanRead({ id: "user_a", role: "member", albumReadScope: "invalid", albumReadProjectIds: [hidden.id] }, hidden), false);
  assert.equal(policy.projectCanRead({ id: "user_a", role: "member", albumReadScope: "invalid" }, owned), true);
  assert.equal(policy.projectCanRead(null, hidden), false);
});

test("相册读取：仅本人和指定相册可见，指定查看不授予管理或创建权限", () => {
  const member = { id: "user_a", role: "member", albumReadScope: "own-and-selected", albumReadProjectIds: [selected.id] };
  assert.equal(policy.projectCanRead(member, owned), true);
  assert.equal(policy.projectCanRead(member, selected), true);
  assert.equal(policy.projectCanRead(member, hidden), false);
  assert.equal(policy.projectCanManage(member, owned), true);
  assert.equal(policy.projectCanManage(member, selected), false);
  assert.equal(policy.projectCanCreate(member), true);
  const viewer = { ...member, role: "viewer" };
  assert.equal(policy.projectCanRead(viewer, selected), true);
  assert.equal(policy.projectCanManage(viewer, selected), false);
  assert.equal(policy.projectCanManage(viewer, owned), false);
  assert.equal(policy.projectCanCreate(viewer), false);
});

test("总部相册授权校验：拒绝非法模式、形态和不存在的相册，去重排序且不修改原资料", () => {
  const member = { id: "user_a", role: "member" };
  const original = JSON.stringify(member);
  for (const body of [
    { albumReadScope: "mine" },
    { albumReadScope: "own-and-selected", albumReadProjectIds: "project_selected" },
    { albumReadScope: "own-and-selected", albumReadProjectIds: ["missing"] },
    { albumReadScope: "all", albumReadProjectIds: [{ id: selected.id }] },
    { albumReadScope: "all", albumReadProjectIds: Array(1001).fill(selected.id) }
  ]) assert.throws(() => policy.parseAlbumReadPolicy(body, member, projects), error => error.statusCode === 400);
  assert.deepEqual(plain(policy.parseAlbumReadPolicy({ albumReadScope: "own-and-selected", albumReadProjectIds: [selected.id, owned.id, selected.id] }, member, projects)), {
    scope: "own-and-selected", projectIds: [owned.id, selected.id]
  });
  assert.equal(policy.parseAlbumReadPolicy({}, member, projects), null);
  assert.equal(JSON.stringify(member), original);
});

test("总部相册授权校验：all 清空无效限制，总部忽略普通查看范围且永远 all", () => {
  const restricted = { id: "user_a", role: "member", albumReadScope: "own-and-selected", albumReadProjectIds: [selected.id] };
  assert.deepEqual(plain(policy.parseAlbumReadPolicy({ albumReadScope: "all", albumReadProjectIds: [] }, restricted, projects)), { scope: "all", projectIds: [] });
  assert.deepEqual(plain(policy.parseAlbumReadPolicy({ albumReadScope: "invalid", albumReadProjectIds: "invalid" }, { role: "admin" }, projects)), { scope: "all", projectIds: [] });
  assert.deepEqual(plain(policy.albumReadPolicy({ ...restricted, role: "admin" })), { scope: "all", projectIds: [] });
  assert.deepEqual(plain(policy.albumReadPolicy({ ...restricted, albumReadProjectIds: [selected.id, selected.id, owned.id] })), {
    scope: "own-and-selected", projectIds: [owned.id, selected.id]
  });
});
