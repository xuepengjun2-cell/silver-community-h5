"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const maintenance = require("../scripts/replace-album-videos.cjs");
const { stable, hash, validateManifest, sourceKey, newUrl, patchMedia, buildExpectedRows, assertRowsEqual, assertStartupStable, validateOptions, safePath, assertPrivateFile } = maintenance;
const MiB = 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));

function manifest(count = 1) {
  return { version: 1, items: Array.from({ length: count }, (_, index) => ({
    projectId: "project_test", index: index + 1,
    sourceUrl: `https://proj2.likeduoduiyi.cn/silver-project-videos/source-${index}.mp4`,
    sourceSize: 459543328 + index, sourceSha256: "a".repeat(64), sourceEtag: `"source-etag-${index}"`,
    newFilename: `maintenance-${index}.mp4`, newSize: 180000000, newSha256: "b".repeat(64),
    posterFilename: `maintenance-${index}.jpg`, posterSize: 20000, posterSha256: "c".repeat(64)
  })) };
}
function fixture(count = 1) {
  const input = manifest(count);
  const media = [{ type: "image", url: "https://proj2.likeduoduiyi.cn/silver-project-images/cover.jpg", title: "保留照片", size: 100 }];
  for (const item of input.items) media.push({ type: "video", url: item.sourceUrl, size: item.sourceSize,
    title: `培训视频 ${item.index}`, caption: "保留说明", createdAt: "2026-08-17T01:02:03.000Z", fingerprint: "d".repeat(64) });
  media.push({ type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/small.mp4", size: 20 * MiB, title: "不在本次维护范围" });
  const project = { id: "project_test", owner_id: "user_original", status: "published", created_at: "old-created", updated_at: "old-updated",
    doc: { id: "project_test", ownerId: "user_original", title: "原相册标题", description: "原说明", status: "published", shareEnabled: true,
      cover: media[0].url, activityId: "act_original", sourceCaseId: "case_original", createdAt: "old-created", updatedAt: "old-updated", media } };
  const snapshot = {
    users: [{ id: "user_original", role: "member", status: "active", doc: { id: "user_original", role: "member", canDownload: false } }],
    activities: [{ id: "act_original", doc: { title: "原活动" } }], posts: [{ id: "post_original", doc: { text: "原评论" } }],
    cases: [{ id: "case_original", doc: { title: "原案例", media: [{ type: "video", url: input.items[0].sourceUrl }] } }],
    activity_projects: [project, { id: "project_untouched", owner_id: "another_user", doc: { id: "project_untouched", title: "另一相册", media: [{ type: "image", url: "https://example.com/untouched.jpg" }] } }]
  };
  const entries = input.items.map(item => ({ ...item, projectHash: hash(stable(project.doc)), sourceMedia: clone(project.doc.media[item.index]) }));
  return { input, snapshot, entries, doc: project.doc };
}

test("维护清单支持一个或多个明确目标，不硬编码为四条", () => {
  for (const count of [1, 4]) {
    const value = manifest(count), before = clone(value);
    assert.equal(validateManifest(value), value);
    assert.deepEqual(value, before);
  }
});
for (const [label, edit] of [
  ["缺失版本", m => delete m.version], ["未知版本", m => m.version = 2], ["空目标", m => m.items = []],
  ["非数组目标", m => m.items = {}], ["过多目标", m => m.items = manifest(101).items],
  ["无效相册编号", m => m.items[0].projectId = "../project_test"],
  ["负索引", m => m.items[0].index = -1], ["小数索引", m => m.items[0].index = 0.5],
  ["非大视频", m => m.items[0].sourceSize = 100 * MiB], ["原片恰为200MiB", m => m.items[0].sourceSize = 200 * MiB],
  ["原片超过上限", m => m.items[0].sourceSize = 2 * 1024 ** 3 + 1],
  ["交付版为空", m => m.items[0].newSize = 0], ["交付版达到190MiB", m => m.items[0].newSize = 190 * MiB],
  ["交付版大于190MiB", m => m.items[0].newSize = 190 * MiB + 1], ["交付大小非整数", m => m.items[0].newSize = 1.5],
  ["封面为空", m => m.items[0].posterSize = 0], ["封面超限", m => m.items[0].posterSize = 3 * MiB + 1],
  ["空ETag", m => m.items[0].sourceEtag = ""], ["ETag换行注入", m => m.items[0].sourceEtag = "etag\r\nInjected: yes"],
  ["输出路径穿越", m => m.items[0].newFilename = "../delivery.mp4"],
  ["输出绝对路径", m => m.items[0].newFilename = "/tmp/delivery.mp4"],
  ["输出反斜线", m => m.items[0].newFilename = "..\\delivery.mp4"],
  ["输出编码斜线", m => m.items[0].newFilename = "..%2fdelivery.mp4"],
  ["输出格式错误", m => m.items[0].newFilename = "delivery.mov"],
  ["封面路径穿越", m => m.items[0].posterFilename = "../poster.jpg"],
  ["封面格式错误", m => m.items[0].posterFilename = "poster.svg"],
  ["覆盖原对象", m => m.items[0].newFilename = "source-0.mp4"]
]) test(`清单拒绝${label}`, () => { const value = manifest(); edit(value); assert.throws(() => validateManifest(value)); });
for (const field of ["sourceSha256", "newSha256", "posterSha256"]) {
  test(`清单拒绝无效 ${field}`, () => {
    for (const value of ["", "a".repeat(63), "g".repeat(64), "A".repeat(64), 123]) {
      const input = manifest(); input.items[0][field] = value; assert.throws(() => validateManifest(input));
    }
  });
}
for (const field of ["slot", "sourceUrl", "newFilename", "posterFilename"]) test(`清单拒绝重复 ${field}`, () => {
  const input = manifest(2);
  if (field === "slot") input.items[1].index = input.items[0].index;
  else input.items[1][field] = input.items[0][field];
  assert.throws(() => validateManifest(input));
});

test("来源只能是项目CDN的对应媒体前缀，拒绝外站、签名和路径注入", () => {
  assert.equal(sourceKey("https://proj2.likeduoduiyi.cn/silver-project-videos/%E5%9F%B9%E8%AE%AD.mp4"), "silver-project-videos/培训.mp4");
  assert.equal(sourceKey("https://proj2.likeduoduiyi.cn/silver-project-images/poster.jpg", "image"), "silver-project-images/poster.jpg");
  for (const url of [
    "http://proj2.likeduoduiyi.cn/silver-project-videos/a.mp4",
    "https://proj2.likeduoduiyi.cn.evil.test/silver-project-videos/a.mp4",
    "https://proj2.likeduoduiyi.cn@evil.test/silver-project-videos/a.mp4",
    "https://proj2.likeduoduiyi.cn:443/silver-project-videos/a.mp4",
    "https://proj2.likeduoduiyi.cn/silver-case-videos/a.mp4",
    "https://proj2.likeduoduiyi.cn/silver-project-videos-evil/a.mp4",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/a.mp4?signature=secret",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/a.mp4#fragment",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/../a.mp4",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/%2e%2e",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/a%2fb.mp4",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/a%5cb.mp4",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/%00a.mp4",
    "https://proj2.likeduoduiyi.cn/silver-project-videos/bad%encoding.mp4"
  ]) assert.throws(() => sourceKey(url), url);
  assert.throws(() => sourceKey("https://proj2.likeduoduiyi.cn/silver-project-images/poster.jpg"));
});

test("替换只改变URL、size、fingerprint、poster，保留归属、标题、顺序及原始输入", () => {
  const { doc, entries } = fixture(2), before = clone(doc);
  const output = patchMedia(doc, entries);
  assert.deepEqual(doc, before);
  assert.equal(output.media.length, before.media.length);
  assert.deepEqual({ ...output, media: undefined }, { ...before, media: undefined });
  for (const entry of entries) {
    const item = output.media[entry.index];
    assert.equal(item.url, newUrl(entry)); assert.equal(item.size, entry.newSize);
    assert.equal(item.fingerprint, entry.newSha256); assert.equal(item.poster, newUrl(entry, true));
    const restoreAllowedFields = { ...item };
    for (const field of ["url", "size", "fingerprint", "poster"]) {
      if (Object.hasOwn(entry.sourceMedia, field)) restoreAllowedFields[field] = entry.sourceMedia[field]; else delete restoreAllowedFields[field];
    }
    assert.deepEqual(restoreAllowedFields, entry.sourceMedia);
  }
  assert.deepEqual(output.media[0], before.media[0]);
  assert.deepEqual(output.media.at(-1), before.media.at(-1));
});
test("来源缺少旧size时依据清单来源验收仍可替换，不虚构旧元数据", () => {
  const { doc, entries } = fixture(); delete doc.media[1].size; delete entries[0].sourceMedia.size;
  const output = patchMedia(doc, entries);
  assert.equal(output.media[1].size, entries[0].newSize);
  assert.equal(Object.hasOwn(patchMedia(output, entries, "rollback").media[1], "size"), false);
});
for (const [label, edit] of [
  ["源类型", (doc, entries) => entries[0].sourceMedia.type = "image"],
  ["源URL", (doc, entries) => entries[0].sourceMedia.url += "changed"],
  ["源体积", (doc, entries) => entries[0].sourceMedia.size++],
  ["媒体索引", (doc, entries) => entries[0].index = 0],
  ["已编辑标题", doc => doc.media[1].title = "另一个标题"],
  ["已变URL", doc => doc.media[1].url += "changed"],
  ["重复索引", (doc, entries) => entries.push(clone(entries[0]))]
]) test(`替换拒绝不匹配的${label}`, () => { const { doc, entries } = fixture(); edit(doc, entries); assert.throws(() => patchMedia(doc, entries)); });

test("回滚仅接受本次完整替换结果，精确恢复原媒体并拒绝覆盖后续编辑", () => {
  const { doc, entries } = fixture(), replaced = patchMedia(doc, entries);
  assert.deepEqual(patchMedia(replaced, entries, "rollback"), doc);
  assert.throws(() => patchMedia(doc, entries, "rollback"));
  for (const field of ["url", "size", "fingerprint", "poster", "title", "caption"]) {
    const edited = clone(replaced); edited.media[1][field] = field === "size" ? 123 : "changed";
    assert.throws(() => patchMedia(edited, entries, "rollback"), field);
  }
  assert.throws(() => patchMedia(doc, entries, "delete"));
});

test("数据库计划只修改目标doc内媒体，其他行、表、列与案例原引用保持不变", () => {
  const { snapshot, entries } = fixture(2), original = clone(snapshot);
  const output = buildExpectedRows(snapshot, entries);
  assert.deepEqual(snapshot, original);
  for (const table of ["users", "activities", "posts", "cases"]) assert.deepEqual(output[table], original[table]);
  assert.deepEqual(output.activity_projects[1], original.activity_projects[1]);
  assert.deepEqual({ ...output.activity_projects[0], doc: undefined }, { ...original.activity_projects[0], doc: undefined });
  assert.deepEqual(buildExpectedRows(output, entries, "rollback"), original);
  assert.throws(() => buildExpectedRows(snapshot, [{ ...entries[0], projectId: "project_missing" }]));
});
test("整库CAS拒绝过期before快照，以及任何非目标数据和权限变化", () => {
  const { snapshot, entries } = fixture(), expected = buildExpectedRows(snapshot, entries);
  assert.doesNotThrow(() => assertRowsEqual(clone(snapshot), snapshot));
  assert.throws(() => assertRowsEqual(expected, snapshot));
  for (const edit of [
    rows => rows.users[0].doc.canDownload = true,
    rows => rows.activity_projects[0].doc.ownerId = "foreign_owner",
    rows => rows.activity_projects[0].owner_id = "foreign_owner",
    rows => rows.activity_projects[0].doc.title = "后续编辑",
    rows => rows.activity_projects[0].doc.media.reverse(),
    rows => rows.activity_projects[1].doc.title = "非目标编辑",
    rows => rows.cases[0].doc.title = "案例编辑",
    rows => rows.activities.push({ id: "new_activity" }),
    rows => rows.posts = []
  ]) { const edited = clone(expected); edit(edited); assert.throws(() => assertRowsEqual(edited, expected)); }
});

test("路径与CLI仅允许指定维护目录、显式模式和目录内清单", () => {
  const work = "/var/tmp/silver-album-maintenance-20261011-test", backup = "/var/backups/silver-album-maintenance-20261011-test";
  assert.equal(safePath(work, "work"), work); assert.equal(safePath(backup, "backup"), backup);
  assert.equal(validateOptions(["--mode=audit", `--work=${work}`]).mode, "audit");
  const args = ["--mode=replace", `--work=${work}`, `--backup=${backup}`, `--manifest=${work}/manifest.json`];
  assert.equal(validateOptions(args).mode, "replace");
  assert.equal(validateOptions(["--mode", "rollback", "--work", work, "--backup", backup, "--manifest", `${work}/manifest.json`]).mode, "rollback");
  for (const value of ["/tmp/silver-album-maintenance-test", `${work}/../evil`, `${work}/child`, `${work}/`, `${work}\n`, "relative", "/var/tmp/silver-auth-release-test"]) assert.throws(() => safePath(value, "work"));
  for (const invalid of [
    [...args, "--mode=rollback"], [...args, "--unknown=yes"], args.map(arg => arg === "--mode=replace" ? "--mode=delete" : arg),
    args.map(arg => arg.startsWith("--manifest=") ? "--manifest=/etc/silver-community.env" : arg),
    args.map(arg => arg.startsWith("--manifest=") ? `--manifest=${work}/../manifest.json` : arg),
    ["--mode=replace", `--work=${work}`, `--backup=${backup}`, "--manifest"]
  ]) assert.throws(() => validateOptions(invalid));
});
function startupFixture() {
  const result = fixture();
  for (const row of result.snapshot.activity_projects) row.doc.media = row.doc.media.map(item => ({
    ...item, title: item.title || "", caption: item.caption || "", createdAt: item.createdAt || "2026-08-17T01:02:03.000Z"
  }));
  result.entries[0].sourceMedia = clone(result.snapshot.activity_projects[0].doc.media[1]);
  return result;
}
test("重启前确认全相册媒体规范化无副作用，替换前后都能通过", () => {
  const { snapshot, entries } = startupFixture(), original = clone(snapshot);
  assert.doesNotThrow(() => assertStartupStable(snapshot));
  assert.doesNotThrow(() => assertStartupStable(buildExpectedRows(snapshot, entries)));
  assert.deepEqual(snapshot, original);
});
for (const [label, edit] of [
  ["文档媒体", rows => rows.activity_projects[0].doc.media.push({ type: "document", url: "https://example.com/file.pdf" })],
  ["未知字段", rows => rows.activity_projects[0].doc.media[1].filename = "old.mp4"],
  ["缺失时间戳", rows => delete rows.activity_projects[0].doc.media[1].createdAt],
  ["重复指纹", rows => rows.activity_projects[0].doc.media.push({ ...rows.activity_projects[0].doc.media[1], url: "https://proj2.likeduoduiyi.cn/silver-project-videos/duplicate.mp4" })],
  ["不可信封面", rows => rows.activity_projects[0].doc.media[1].poster = "https://example.com/poster.jpg"],
  ["空白标题被裁剪", rows => rows.activity_projects[0].doc.media[1].title += " "],
  ["非数组素材", rows => rows.activity_projects[0].doc.media = {}],
  ["非目标相册未知字段", rows => rows.activity_projects[1].doc.media[0].unknown = true]
]) test(`重启守卫拒绝会改写现有数据的${label}`, () => { const { snapshot } = startupFixture(); edit(snapshot); assert.throws(() => assertStartupStable(snapshot)); });
test("备份文件必须0600、父目录0700，文件和目录软链接均拒绝", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "silver-maintenance-test-")));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "state.json"); fs.writeFileSync(file, "{}", { mode: 0o600 }); fs.chmodSync(file, 0o600);
    assert.doesNotThrow(() => assertPrivateFile(file));
    fs.chmodSync(file, 0o644); assert.throws(() => assertPrivateFile(file)); fs.chmodSync(file, 0o600);
    fs.chmodSync(directory, 0o755); assert.throws(() => assertPrivateFile(file)); fs.chmodSync(directory, 0o700);
    const linkedFile = path.join(directory, "linked.json"); fs.symlinkSync(file, linkedFile); assert.throws(() => assertPrivateFile(linkedFile));
    const child = path.join(directory, "child"); fs.mkdirSync(child, { mode: 0o700 }); fs.writeFileSync(path.join(child, "state.json"), "{}", { mode: 0o600 });
    const linkedDirectory = path.join(directory, "linked-directory"); fs.symlinkSync(child, linkedDirectory); assert.throws(() => assertPrivateFile(path.join(linkedDirectory, "state.json")));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
