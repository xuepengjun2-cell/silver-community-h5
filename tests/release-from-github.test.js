"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const release = require("../deploy/release-from-github.cjs");
const target = "a".repeat(40), base = "b".repeat(40), digest = "c".repeat(64);
const run = { id: 1, name: "Check", path: ".github/workflows/check.yml", head_sha: target, head_branch: "main", event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/example/actions/runs/1" };
const ci = release.validateCi({ workflow_runs: [run] }, target);
const clone = value => JSON.parse(JSON.stringify(value));
test("发布默认dry-run，显式apply且40SHA基线必填", () => {
  assert.equal(release.options([`--base=${base}`]).apply, false);
  assert.equal(release.options([`--base=${base}`, `--sha=${target}`, "--apply"]).apply, true);
  for (const args of [[], ["--apply"], [`--base=${base}`, "--apply", "--apply"], [`--base=${base}`, `--base=${base}`], ["--base=abcdef0"], [`--base=${base}`, "--force"], [`--base=${base}`, "--sha=" + "A".repeat(40)]]) assert.throws(() => release.options(args));
  const connection = release.identityOptions({});
  assert.deepEqual(connection, ["-i", "/Users/a1234/.ssh/kkhc_hq_deploy_ed25519", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]);
  assert.equal(release.identityOptions({ SILVER_DEPLOY_IDENTITY: "/Users/example/.ssh/deploy key" })[1], "/Users/example/.ssh/deploy key");
  for (const identity of ["", "relative/key", "~/.ssh/key", "/tmp/../etc/key", "/tmp/key\n"]) assert.throws(() => release.identityOptions({ SILVER_DEPLOY_IDENTITY: identity }));
});
test("CI证据必须为同SHA main push的Check，最新失败或待完成禁止降级采用旧成功", () => {
  assert.equal(ci.head_sha, target);
  for (const edit of [r => r.head_sha = base, r => r.head_branch = "feature", r => r.event = "pull_request", r => r.path = "evil.yml", r => r.status = "in_progress", r => r.conclusion = "failure", r => r.name = "Unrelated"]) {
    const modified = clone(run); edit(modified); assert.throws(() => release.validateCi({ workflow_runs: [modified] }, target));
  }
  assert.throws(() => release.validateCi({ workflow_runs: [run, { ...run, id: 2, conclusion: "failure" }] }, target));
  assert.throws(() => release.validateCi({ workflow_runs: [] }, target));
});
test("发布仅允许明确代码白名单，不含数据、密钥、依赖或miniapp", () => {
  for (const file of ["server.js", "server/miniapp-media.js", "public/app.js", "public/admin.css", "public/index.html", "package.json"]) assert.equal(release.allowed(file), true);
  for (const file of ["../server.js", "/server.js", "server/../server.js", "server/nested/a.js", "public/assets/photo.jpg", "data/db.json", ".env", "package-lock.json", "node_modules/x.js", "miniapp/app.js", "server/a.js\n"]) assert.equal(release.allowed(file), false);
  assert.doesNotThrow(() => release.assertCodeHash("server.js", digest, digest, "Runtime baseline mismatch"));
  assert.throws(() => release.assertCodeHash("public/app.js", "d".repeat(64), digest, "Runtime baseline mismatch"), error => error.message === `Runtime baseline mismatch: public/app.js; expected=${digest}; actual=${"d".repeat(64)}`);
  assert.throws(() => release.assertCodeHash("server/new-module.js", null, digest, "GitHub source mismatch"), /actual=absent/);
  assert.throws(() => release.assertCodeHash(".env", "secret", "expected", "Runtime baseline mismatch"), /Invalid code hash path/);
});
test("GitHub归档路径必须单一根目录且无穿越", () => {
  assert.equal(release.archiveNames("repo-abc/\nrepo-abc/server.js\nrepo-abc/server/a.js\n"), "repo-abc");
  for (const names of ["/absolute/a\n", "repo/a\nother/b", "repo/a\nrepo/../secret", "repo/a\nrepo/./b", "repo/a\nrepo/evil\\path"]) assert.throws(() => release.archiveNames(names));
});
test("仅版本和测试脚本漂移可兼容，dependencies及其他配置变化一律拒绝", () => {
  const before = { version: "1.0.0", scripts: { check: "old" }, dependencies: { mysql2: "^3.11.0" }, engines: { node: ">=18" } };
  assert.doesNotThrow(() => release.assertPackages(before, { ...before, version: "1.0.1", scripts: { check: "new" } }));
  for (const after of [{ ...before, dependencies: { mysql2: "^4" } }, { ...before, devDependencies: { x: "1" } }, { ...before, engines: { node: ">=20" } }, { ...before, optionalDependencies: { x: "1" } }]) assert.throws(() => release.assertPackages(before, after));
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "silver-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["before", "after"]) {
    const dir = `${root}/${name}`;
    for (const sub of ["server", "public", "deploy"]) fs.mkdirSync(`${dir}/${sub}`, { recursive: true });
    fs.writeFileSync(`${dir}/server.js`, fs.readFileSync(path.join(__dirname, "../server.js")));
    fs.writeFileSync(`${dir}/server/helper.js`, "module.exports = {};\n");
    fs.writeFileSync(`${dir}/public/app.js`, "void 0;\n");
    fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "test", version: "1.0.0", dependencies: { x: "1" } }));
    fs.writeFileSync(`${dir}/package-lock.json`, "locked");
    fs.copyFileSync(path.join(__dirname, "../deploy/release-from-github.cjs"), `${dir}/deploy/release-from-github.cjs`);
  }
  return { before: `${root}/before`, after: `${root}/after` };
}
test("发布计划绑定基线、目标、归档及执行器哈希并记录新增模块", t => {
  const f = fixture(t); fs.writeFileSync(`${f.after}/server/new-module.js`, "void 1;\n");
  const p = release.plan(f.before, f.after, target, base, ci, digest);
  assert.equal(release.validatePlan(p), p);
  assert.equal(p.files.find(item => item.file === "server/new-module.js").before, null);
  assert.equal(p.executorHash, release.hash(fs.readFileSync(`${f.after}/deploy/release-from-github.cjs`)));
  assert.equal(p.files.some(item => item.file.startsWith("deploy/")), false);
});
test("计划拒绝依赖锁、启动schema逻辑改动及运行文件删除", t => {
  for (const action of [f => fs.writeFileSync(`${f.after}/package-lock.json`, "changed"), f => fs.unlinkSync(`${f.after}/server/helper.js`), f => fs.writeFileSync(`${f.after}/server.js`, fs.readFileSync(`${f.after}/server.js`, "utf8").replace("async function initDb() {", "async function initDb() {\n  dangerous();"))]) {
    const f = fixture(t); action(f); assert.throws(() => release.plan(f.before, f.after, target, base, ci, digest));
  }
});
test("远端清单拒绝篡改CI、非法路径、重复文件及不完整哈希", t => {
  const f = fixture(t), original = release.plan(f.before, f.after, target, base, ci, digest);
  for (const edit of [p => p.ci.head_sha = base, p => p.ci.conclusion = "failure", p => p.target = "short", p => p.archiveHash = "bad", p => p.files[0].file = "data/db.json", p => p.files.push(p.files[0]), p => p.files = [], p => p.files[0].before = "bad", p => p.files[0].after = "bad"]) {
    const value = clone(original); edit(value); assert.throws(() => release.validatePlan(value));
  }
});
test("启动前用实际server规范化函数确认完整相册不会被改写", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const doc = { id: "project_test", title: "培训", activityId: "", ownerId: "user_a", ownerName: "甲", city: "北京", dateLabel: "", description: "", cover: "", media: [{ type: "video", url: "https://example.com/a.mp4", title: "", caption: "", createdAt: "2026-10-11" }], status: "published", shareEnabled: true, sourceCaseId: "", createdAt: "2026-10-11", updatedAt: "2026-10-11" };
  assert.doesNotThrow(() => release.assertStartup([{ doc }], source));
  for (const edit of [d => d.media[0].type = "document", d => d.extra = "lost", d => delete d.media[0].createdAt, d => delete d.updatedAt, d => d.media[0].unknown = "lost"]) {
    const changed = clone(doc); edit(changed); assert.throws(() => release.assertStartup([{ doc: changed }], source));
  }
});
test("业务CAS保留所有表字段，任何非目标内容变化均拒绝", () => {
  const original = { users: [{ id: "a", passwordHash: "secret" }], activity_projects: [{ owner_id: "a", doc: { title: "原相册", media: [1, 2] } }] };
  release.sameData(original, clone(original));
  for (const edit of [d => d.users = [], d => d.users[0].passwordHash = "new", d => d.activity_projects[0].owner_id = "b", d => d.activity_projects[0].doc.media.reverse()]) { const changed = clone(original); edit(changed); assert.throws(() => release.sameData(original, changed)); }
});
test("原子代码复制完整替换且不遗留临时文件", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "silver-atomic-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(`${root}/source`, "new code"); fs.writeFileSync(`${root}/target`, "old code");
  release.atomicCopy(`${root}/source`, `${root}/target`);
  assert.equal(fs.readFileSync(`${root}/target`, "utf8"), "new code");
  assert.deepEqual(fs.readdirSync(root).sort(), ["source", "target"]);
});
