"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const release = require("../deploy/release-from-github.cjs");
const tool = require("../deploy/release-static-from-github.cjs");
const target = "a".repeat(40), base = "b".repeat(40), ci = { head_sha: target, conclusion: "success" };
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-static-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["before", "after"]) for (const sub of ["public", "deploy"]) fs.mkdirSync(`${dir}/${folder}/${sub}`, { recursive: true });
  for (const name of new Set(tool.OBJECTS.map(o => o.source))) {
    fs.writeFileSync(`${dir}/after/public/${name}`, `target ${name}`);
    if (tool.FILES.includes(name)) fs.writeFileSync(`${dir}/before/public/${name}`, `old ${name}`);
  }
  fs.writeFileSync(`${dir}/after/public/index.html`, '<script src="./app.js?v=fixture-1"></script>');
  fs.writeFileSync(`${dir}/after/public/admin.html`, '<script src="./admin.js?v=fixture-1"></script>');
  fs.copyFileSync(path.join(__dirname, "../deploy/release-static-from-github.cjs"), `${dir}/after/deploy/release-static-from-github.cjs`);
  const plan = tool.plan(`${dir}/before`, `${dir}/after`, target, base, ci, "d".repeat(64), "internal");
  const objects = new Map(), events = [];
  for (const entry of tool.OBJECTS) {
    // Existing target aliases model interrupted safe continuation; canonical files old.
    const bytes = tool.FILES.includes(entry.name) ? Buffer.from(`old ${entry.source}`) : fs.readFileSync(`${dir}/after/public/${entry.source}`);
    objects.set(tool.key(entry.name), { bytes, etag: `"etag-${entry.name}"`, metadata: { contentType: entry.source.endsWith(".js") ? "application/javascript" : entry.source.endsWith(".css") ? "text/css" : "text/html", cacheControl: "old-cache", meta: { preserve: "yes" } }, acl: { Owner: { ID: "owner" }, Grants: [{ Grantee: { ID: "owner" }, Permission: "FULL_CONTROL" }] } });
  }
  let sequence = 0;
  const client = {
    async getObjectAcl({ key }) { return { data: clone(objects.get(key).acl) }; },
    async putObjectAcl({ key, aclBody }) { objects.get(key).acl = clone(aclBody); events.push({ type: "acl", key }); },
    async putObject(value) {
      assert.equal(value.bucket, "static-bucket"); assert.ok(objects.has(value.key));
      const old = objects.get(value.key); assert.equal(value.ifMatch, old.etag); assert.equal(value.headers["If-Match"], old.etag);
      objects.set(value.key, { ...old, bytes: Buffer.from(value.body), etag: `"new-${++sequence}"`, metadata: { contentType: value.contentType, cacheControl: value.cacheControl, meta: value.meta } });
      events.push({ type: "put", key: value.key });
    }
  };
  const origin = async name => { const obj = objects.get(tool.key(name)); return { ...clone({ etag: obj.etag, metadata: obj.metadata }), bytes: Buffer.from(obj.bytes), sha256: release.hash(obj.bytes) }; };
  const publicRead = async name => Buffer.from(objects.get(tool.key(name)).bytes);
  const versionedRead = async url => publicRead(path.basename(new URL(url).pathname));
  return { dir, source: `${dir}/after`, backup: `${dir}/backup`, plan, objects, client, events, origin, publicRead, versionedRead };
}
test("静态默认dryrun，前缀必须显式确认且仅public/internal网络", () => {
  assert.equal(tool.options([`--base=${base}`, "--prefix=silver/"]).apply, false);
  assert.equal(tool.options([`--base=${base}`, "--prefix=silver/", "--tos-network=internal", "--apply"]).network, "internal");
  for (const extra of [[], ["--prefix=media/"], ["--prefix=silver/", "--prefix=silver/"], ["--prefix=silver/", "--tos-network=unknown"]]) assert.throws(() => tool.options([`--base=${base}`, ...extra]));
});
test("对象映射只允许六静态文件和四明确别名，新别名使用仓库redirect源", () => {
  assert.equal(tool.OBJECTS.length, 10);
  assert.equal(tool.key("home-root"), "silver"); assert.equal(tool.key("home-directory"), "silver/");
  assert.equal(tool.OBJECTS.find(o => o.name === "admin-route").source, "admin-redirect.html");
  assert.equal(tool.OBJECTS.find(o => o.name === "home-root").source, "silver-redirect.html");
  for (const name of ["../app.js", "data/db.json", "silver-project-videos/a.mp4", "/silver/app.js", "app.js?x=1"]) assert.throws(() => tool.key(name));
});
test("计划绑定十个对象、GH SHA、执行器与CI，拒绝越界和缺漏", t => {
  const f = fixture(t); assert.equal(tool.validatePlan(f.plan), f.plan);
  for (const edit of [p => p.files.pop(), p => p.files[0].name = "data.json", p => p.files[1].name = p.files[0].name, p => p.target = "short", p => p.ci.head_sha = base, p => p.network = "evil", p => p.prefix = "silver-project-videos/", p => p.files[0].size = 0, p => p.files.find(i => i.name === "home-root").before = "e".repeat(64)]) {
    const value = clone(f.plan); edit(value); assert.throws(() => tool.validatePlan(value));
  }
});
test("首次alias使用精确历史来源，后续redirect更新采用Gitbase旧redirect哈希", t => {
  const f = fixture(t);
  for (const name of ["silver-redirect.html", "admin-redirect.html"]) {
    fs.copyFileSync(`${f.source}/public/${name}`, `${f.dir}/before/public/${name}`);
    fs.writeFileSync(`${f.source}/public/${name}`, `new redirect ${name}`);
  }
  const next = tool.plan(`${f.dir}/before`, f.source, target, base, ci, "d".repeat(64), "public");
  for (const name of Object.keys(tool.LEGACY)) {
    const item = next.files.find(f => f.name === name);
    assert.equal(item.legacyFallback, false);
    assert.notEqual(item.before, tool.LEGACY[name]);
    tool.assertOrigin(item, item.before); tool.assertOrigin(item, tool.LEGACY[name]);
  }
});
test("origin只允许明确Git旧值/目标；三个历史SHA按别名绑定不能跨key复用", t => {
  const f = fixture(t), normal = f.plan.files[0];
  tool.assertOrigin(normal, normal.before); tool.assertOrigin(normal, normal.after);
  assert.throws(() => tool.assertOrigin(normal, "f".repeat(64)), /silver\/app.js.*expected=.*actual=/);
  for (const [name, legacy] of Object.entries(tool.LEGACY)) {
    tool.assertOrigin(f.plan.files.find(i => i.name === name), legacy);
    assert.throws(() => tool.assertOrigin(normal, legacy));
  }
});
test("metadata严格保存对象属性而不保存认证头，编码和重定向对象拒绝", () => {
  const value = tool.metadata({ "Content-Type": "text/html", "Cache-Control": "no-cache", "x-tos-meta-version": "old", Authorization: "must-not-save" });
  assert.deepEqual(value, { contentType: "text/html", cacheControl: "no-cache", meta: { version: "old" } });
  assert.throws(() => tool.metadata({ "content-encoding": "gzip" }));
  assert.throws(() => tool.metadata({ "x-tos-website-redirect-location": "https://evil.example" }));
  for (const headers of [{ "x-tos-server-side-encryption": "AES256" }, { "x-tos-object-lock-mode": "GOVERNANCE" }, { "x-tos-tagging-count": "1" }]) assert.throws(() => tool.metadata(headers));
});
test("dryrun全量检查十个origin，不写对象/ACL/备份，支持旧目标混合", async t => {
  const f = fixture(t), reads = [];
  const result = await tool.publish(f.client, "static-bucket", f.plan, f.source, f.backup, false, { origin: async name => { reads.push(name); return f.origin(name); } });
  assert.equal(result.dryRun, true); assert.equal(reads.length, 10); assert.equal(result.objects.filter(o => o.alreadyTarget).length, 4);
  assert.deepEqual(f.events, []); assert.equal(fs.existsSync(f.backup), false);
});
test("apply先私有备份全部字节/metadata/ACL，JS先于HTML，双公网路径与origin都验收", async t => {
  const f = fixture(t), publicReads = [], versioned = [];
  const result = await tool.publish(f.client, "static-bucket", f.plan, f.source, f.backup, true, { origin: f.origin, publicRead: async (name, query) => { publicReads.push([name, query]); return f.publicRead(name); }, versionedRead: async url => { versioned.push(url); return f.versionedRead(url); } });
  assert.equal(result.canonicalPublicVerified, true); assert.equal(result.backendChanged, false); assert.equal(result.databaseChanged, false);
  assert.deepEqual(f.events.filter(e => e.type === "put").map(e => e.key), tool.FILES.map(n => `silver/${n}`));
  assert.equal(publicReads.length, 20); assert.equal(publicReads.filter(([, q]) => q).length, 10);
  assert.deepEqual(versioned.sort(), ["https://proj2.likeduoduiyi.cn/silver/admin.js?v=fixture-1", "https://proj2.likeduoduiyi.cn/silver/app.js?v=fixture-1"]);
  assert.equal(fs.statSync(f.backup).mode & 0o777, 0o700);
  const state = JSON.parse(fs.readFileSync(`${f.backup}/state.json`)); assert.equal(state.files.length, 10);
  for (const item of state.files) { assert.ok(item.acl.Owner); assert.equal(item.metadata.meta.preserve, "yes"); assert.equal(fs.statSync(`${f.backup}/${encodeURIComponent(tool.key(item.name))}`).mode & 0o777, 0o600); }
});
test("公网验收失败只回滚本次写入，已在目标的alias不动并恢复metadata/ACL", async t => {
  const f = fixture(t), before = new Map([...f.objects].map(([k, v]) => [k, { ...v, bytes: Buffer.from(v.bytes), metadata: clone(v.metadata), acl: clone(v.acl) }]));
  await assert.rejects(() => tool.publish(f.client, "static-bucket", f.plan, f.source, f.backup, true, { origin: f.origin, publicRead: async () => Buffer.from("wrong public copy"), versionedRead: f.versionedRead }), /own writes rolled back/);
  for (const [key, old] of before) { const now = f.objects.get(key); assert.deepEqual(now.bytes, old.bytes); assert.deepEqual(now.metadata, old.metadata); assert.deepEqual(now.acl, old.acl); }
  assert.equal(f.events.some(e => ["silver", "silver/", "silver/admin", "silver/admin/"].includes(e.key)), false);
});
test("PUT已成功但响应丢失也可按内容+ETag安全回滚", async t => {
  const f = fixture(t), put = f.client.putObject.bind(f.client); let first = true;
  f.client.putObject = async input => { await put(input); if (first) { first = false; throw Error("network failure with sensitive URL"); } };
  await assert.rejects(() => tool.publish(f.client, "static-bucket", f.plan, f.source, f.backup, true, { origin: f.origin, publicRead: f.publicRead, versionedRead: f.versionedRead }), error => /own writes rolled back/.test(error.message) && !/sensitive URL/.test(error.message));
  assert.equal(f.objects.get("silver/app.js").bytes.toString(), "old app.js");
});
test("检测到后续外部静态编辑时拒绝回滚覆盖，保留备份和明确失败", async t => {
  const f = fixture(t); let changed = false;
  await assert.rejects(() => tool.publish(f.client, "static-bucket", f.plan, f.source, f.backup, true, { origin: f.origin, publicRead: async () => { if (!changed) { changed = true; const obj = f.objects.get("silver/app.js"); obj.bytes = Buffer.from("external edit"); obj.etag = '"external"'; } return Buffer.from("wrong"); }, versionedRead: f.versionedRead }), /rollback needs operator attention/);
  assert.equal(f.objects.get("silver/app.js").bytes.toString(), "external edit");
  assert.equal(fs.existsSync(`${f.backup}/state.json`), true);
});
test("dryrun提前检查ACL且ACL不兼容时不写对象", async t => {
  const f = fixture(t); f.client.getObjectAcl = async () => ({ data: {} });
  await assert.rejects(() => tool.publish(f.client, "static-bucket", f.plan, f.source, f.backup, false, { origin: f.origin }), /ACL unavailable/);
  assert.deepEqual(f.events, []); assert.equal(fs.existsSync(f.backup), false);
});
test("HTML脚本实际v参数须绑定approved同源文件", t => {
  const f = fixture(t); assert.equal(tool.versionedScripts(f.source, f.plan).length, 2);
  for (const src of ["https://evil.example/app.js?v=1", "./app.js", "../app.js?v=1", "./admin.js?v=1"]) {
    fs.writeFileSync(`${f.source}/public/index.html`, `<script src="${src}"></script>`);
    assert.throws(() => tool.versionedScripts(f.source, f.plan));
  }
});
test("两个redirect固定同源目标并完整保留query/hash，避免无斜杠资源回归", () => {
  for (const [file, expected] of [["silver-redirect.html", "/silver/"], ["admin-redirect.html", "/silver/admin.html"]]) {
    const html = fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
    let result;
    const search = "?to=//evil.example&share=project_test", hash = "#https://evil.example";
    new vm.Script(script).runInNewContext({ location: { search, hash, replace: value => result = value } }, { timeout: 100 });
    const url = new URL(result, "https://proj2.likeduoduiyi.cn/silver/admin/");
    assert.equal(url.origin, "https://proj2.likeduoduiyi.cn"); assert.equal(url.pathname, expected); assert.equal(url.search, search); assert.equal(url.hash, hash);
  }
});
