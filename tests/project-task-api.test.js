"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withServer, sleep } = require("./support/video-api-server");

const albumRoute = id => `/my/activity-projects/${id}`;
const taskRoute = (album, task) => `${albumRoute(album)}/media/upload-session/${task}`;
const tosFile = (ctx, key) => path.join(ctx.dir, "tos", encodeURIComponent(key));
const writeObject = (ctx, key, bytes) => {
  fs.mkdirSync(path.join(ctx.dir, "tos"), { recursive: true });
  fs.writeFileSync(tosFile(ctx, key), bytes);
};
const session = (ctx, id) => ctx.persisted().project_upload_sessions.find(row => row.id === id);
const project = async (ctx, token, id) => (await ctx.api(albumRoute(id), { token })).data.project;
const createAlbum = async (ctx, token) => {
  const r = await ctx.api("/my/activity-projects", { method: "POST", token, body: { title: "后台任务测试相册" } });
  assert.equal(r.status, 201, r.data.error);
  return r.data.project.id;
};
const initTask = async (ctx, token, album, bytes = 8192) => {
  const r = await ctx.api(`${albumRoute(album)}/media/init`, { method: "POST", token, body: { type: "video", ext: "mp4", title: "test clip.mp4", size: bytes } });
  assert.equal(r.status, 201, r.data.error);
  return session(ctx, r.data.sessionId);
};
const act = (ctx, token, album, task, action) => ctx.api(`${taskRoute(album, task)}/${action}`, { method: "POST", token, body: {} });
const status = (ctx, token, album, task) => ctx.api(`${taskRoute(album, task)}/status`, { token });
async function until(run, predicate, message, attempts = 100) {
  let result;
  for (let i = 0; i < attempts; i++) {
    result = await run();
    if (predicate(result)) return result;
    await sleep(40);
  }
  assert.fail(`${message}: ${JSON.stringify(result)}`);
}
async function createUser(ctx, admin, username, role) {
  const password = "isolated-task-test-password";
  const made = await ctx.api("/admin/users", { method: "POST", token: admin, body: { username, name: username, role, password } });
  assert.equal(made.status, 201, made.data.error);
  const logged = await ctx.api("/login", { method: "POST", body: { username, password } });
  assert.equal(logged.status, 200, logged.data.error);
  return { id: made.data.user.id, token: logged.data.token };
}

test("paused complete source resumes through verified completion with no duplicate video", () => withServer({ tosDelay: 100 }, async ctx => {
  const token = await ctx.login(), album = await createAlbum(ctx, token), row = await initTask(ctx, token, album);
  const source = crypto.randomBytes(Number(row.file_size));
  writeObject(ctx, row.object_key, source);
  const paused = await act(ctx, token, album, row.id, "pause");
  assert.equal(paused.status, 200); assert.equal(paused.data.status, "paused");
  assert.equal(session(ctx, row.id).status, "paused");
  assert.deepEqual(fs.readFileSync(tosFile(ctx, row.object_key)), source);
  const resumed = await act(ctx, token, album, row.id, "resume");
  assert.equal(resumed.status, 202, resumed.data.error);
  assert.ok(["queued", "processing"].includes(resumed.data.status));
  const complete = await until(() => status(ctx, token, album, row.id), r => ["completed", "delivery_failed"].includes(r.data.status), "task did not complete");
  assert.equal(complete.data.status, "completed", ctx.logs());
  const delivered = (await project(ctx, token, album)).media;
  assert.equal(delivered.length, 1); assert.equal(delivered[0].type, "video");
  assert.match(delivered[0].url, /\.mp4$/); assert.match(delivered[0].poster, /\.jpg$/);
  assert.equal(delivered[0].size, source.length); assert.equal(delivered[0].fingerprint, crypto.createHash("sha256").update(source).digest("hex"));
  const again = await act(ctx, token, album, row.id, "resume");
  assert.equal(again.status, 200); assert.equal(again.data.status, "completed");
  assert.equal((await project(ctx, token, album)).media.length, 1);
}));

test("paused partial upload reports real uploaded parts and resume preserves them", () => withServer({}, async ctx => {
  const token = await ctx.login(), album = await createAlbum(ctx, token), row = await initTask(ctx, token, album, 20 * 1024 * 1024);
  fs.mkdirSync(path.join(ctx.dir, "tos"), { recursive: true });
  const parts = [{ PartNumber: 1, Size: Number(row.part_size), ETag: "first-part-retained" }];
  const metadata = `${tosFile(ctx, row.object_key)}.parts.json`;
  fs.writeFileSync(metadata, JSON.stringify(parts));
  assert.equal((await act(ctx, token, album, row.id, "pause")).data.status, "paused");
  const paused = await status(ctx, token, album, row.id);
  assert.equal(paused.status, 200, paused.data.error); assert.equal(paused.data.status, "paused");
  assert.equal(paused.data.fileSize, Number(row.file_size)); assert.equal(paused.data.partCount, 2);
  assert.deepEqual(paused.data.completedParts, [1]); assert.equal(paused.data.uploadedBytes, Number(row.part_size));
  const resumed = await act(ctx, token, album, row.id, "resume");
  assert.equal(resumed.status, 200, resumed.data.error); assert.equal(resumed.data.status, "uploading");
  assert.deepEqual(resumed.data.completedParts, [1]); assert.equal(resumed.data.uploadedBytes, Number(row.part_size));
  assert.equal(session(ctx, row.id).status, "uploading"); assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), parts);
  assert.equal((await project(ctx, token, album)).media.length, 0);
}));

function seededTasks(status = "queued") {
  const now = new Date().toISOString(), album = "project_task_api_seed", id = "project_upload_0123456789abcdef";
  const source = crypto.randomBytes(4096), salt = "isolated-task-api";
  const admin = { id: "u_admin", username: "admin", name: "Test Admin", role: "admin", status: "active", salt,
    passwordHash: crypto.createHash("sha256").update(`${salt}:admin123`).digest("hex") };
  const objectKey = "silver-project-video-sources/task-api-seed.mp4";
  const upload = { id, project_id: album, owner_id: admin.id, status, file_size: source.length, part_size: 16777216, part_count: 1,
    filename: "task-api-seed.mp4", title: "seeded clip.mp4", object_key: objectKey, upload_id: "fake-upload", created_at: now, updated_at: now };
  const albumDoc = { id: album, title: "恢复测试相册", ownerId: admin.id, status: "published", shareEnabled: true, media: [] };
  return { album, id, source, objectKey, albumDoc, upload, seed: {
    users: [{ id: admin.id, username: admin.username, role: admin.role, doc: JSON.stringify(admin) }],
    activity_projects: [{ id: album, owner_id: admin.id, status: "published", created_at: now, updated_at: now, doc: JSON.stringify(albumDoc) }],
    project_upload_sessions: [upload]
  } };
}

test("dismissing failed and completed tasks hides only records, preserving original and published objects", () => {
  const seeded = seededTasks("delivery_failed"), now = new Date().toISOString();
  const delivered = { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/kept.mp4", poster: "https://proj2.likeduoduiyi.cn/silver-project-images/kept.jpg", size: 4096, fingerprint: "a".repeat(64), title: "已发布素材", caption: "", createdAt: now };
  seeded.albumDoc.media = [delivered]; seeded.seed.activity_projects[0].doc = JSON.stringify(seeded.albumDoc);
  const completed = { ...seeded.upload, id: "project_upload_fedcba9876543210", status: "completed", media_url: delivered.url, object_key: "silver-project-video-sources/kept-source.mp4" };
  seeded.seed.project_upload_sessions.push(completed);
  return withServer({ seed: seeded.seed, beforeStart({ dir }) {
    for (const key of [seeded.objectKey, completed.object_key, "silver-project-videos/kept.mp4", "silver-project-images/kept.jpg"]) writeObject({ dir }, key, seeded.source);
  } }, async ctx => {
    const token = await ctx.login();
    for (const id of [seeded.id, completed.id]) {
      const removed = await act(ctx, token, seeded.album, id, "dismiss");
      assert.equal(removed.status, 200, removed.data.error); assert.equal(removed.data.status, "dismissed");
      assert.equal((await status(ctx, token, seeded.album, id)).status, 409);
    }
    const list = await ctx.api(`${albumRoute(seeded.album)}/media/upload-sessions`, { token });
    assert.deepEqual(list.data.sessions, []);
    assert.deepEqual((await project(ctx, token, seeded.album)).media, [delivered]);
    for (const key of [seeded.objectKey, completed.object_key, "silver-project-videos/kept.mp4", "silver-project-images/kept.jpg"]) assert.deepEqual(fs.readFileSync(tosFile(ctx, key)), seeded.source);
  });
});

test("viewer, unrelated operator, and anonymous calls cannot manage another uploader's task", () => withServer({}, async ctx => {
  const admin = await ctx.login(), owner = await createUser(ctx, admin, "task-owner", "operator"), other = await createUser(ctx, admin, "task-other", "operator"), viewer = await createUser(ctx, admin, "task-viewer", "viewer");
  const album = await createAlbum(ctx, owner.token), row = await initTask(ctx, owner.token, album);
  for (const token of [other.token, viewer.token]) {
    for (const action of ["pause", "resume", "dismiss"]) assert.equal((await act(ctx, token, album, row.id, action)).status, 403);
    assert.equal((await status(ctx, token, album, row.id)).status, 403);
  }
  assert.equal((await act(ctx, undefined, album, row.id, "dismiss")).status, 401);
  assert.equal(session(ctx, row.id).status, "uploading");
  assert.equal((await act(ctx, owner.token, album, row.id, "pause")).data.status, "paused");
}));

test("stop during slow output upload prevents publication and retains original", () => withServer({ tosDelay: 600 }, async ctx => {
  const token = await ctx.login(), album = await createAlbum(ctx, token), row = await initTask(ctx, token, album);
  const source = crypto.randomBytes(Number(row.file_size)); writeObject(ctx, row.object_key, source);
  assert.equal((await act(ctx, token, album, row.id, "resume")).status, 202);
  await until(() => status(ctx, token, album, row.id), r => r.data.progress?.stage === "uploading", "task never reached output upload");
  const paused = await act(ctx, token, album, row.id, "pause");
  assert.equal(paused.status, 200); assert.equal(paused.data.status, "paused");
  await sleep(850);
  assert.equal(session(ctx, row.id).status, "paused", ctx.logs());
  assert.equal((await project(ctx, token, album)).media.length, 0);
  assert.deepEqual(fs.readFileSync(tosFile(ctx, row.object_key)), source);
  assert.deepEqual(fs.readdirSync(path.join(ctx.dir, "tos")), [encodeURIComponent(row.object_key)], "unpublished derivative must be cleaned, original retained");
}));

test("revoked requesting admin is rechecked after delayed HEAD even while uploader remains allowed", () => withServer({ headDelay: 350 }, async ctx => {
  const hq = await ctx.login(), owner = await createUser(ctx, hq, "task-source-owner", "operator"), manager = await createUser(ctx, hq, "task-manager", "admin");
  const album = await createAlbum(ctx, owner.token), row = await initTask(ctx, owner.token, album);
  writeObject(ctx, row.object_key, crypto.randomBytes(Number(row.file_size)));
  const resuming = act(ctx, manager.token, album, row.id, "resume");
  await sleep(80);
  const demoted = await ctx.api(`/admin/users/${manager.id}`, { method: "PUT", token: hq, body: { role: "viewer", status: "active" } });
  assert.equal(demoted.status, 200, demoted.data.error);
  const denied = await resuming;
  assert.equal(denied.status, 403, denied.data.error);
  assert.equal(session(ctx, row.id).status, "uploading");
  assert.equal((await project(ctx, owner.token, album)).media.length, 0);
  assert.ok(fs.existsSync(tosFile(ctx, row.object_key)));
}));

test("headquarters can stop and dismiss a revoked uploader's task without resuming or publishing it", async () => {
  for (const change of [{ role: "operator", status: "disabled" }, { role: "viewer", status: "active" }]) {
    await withServer({ tosDelay: 350 }, async ctx => {
      const hq = await ctx.login(), owner = await createUser(ctx, hq, "task-revoked-owner", "operator");
      const album = await createAlbum(ctx, owner.token), row = await initTask(ctx, owner.token, album);
      const source = crypto.randomBytes(Number(row.file_size)); writeObject(ctx, row.object_key, source);
      assert.equal((await act(ctx, owner.token, album, row.id, "resume")).status, 202);
      await until(() => status(ctx, hq, album, row.id), r => r.data.progress?.stage === "uploading", "owner task never reached output upload");
      const revoked = await ctx.api(`/admin/users/${owner.id}`, { method: "PUT", token: hq, body: change });
      assert.equal(revoked.status, 200, revoked.data.error);
      const paused = await act(ctx, hq, album, row.id, "pause");
      assert.equal(paused.status, 200, paused.data.error); assert.equal(paused.data.status, "paused");
      const denied = await act(ctx, hq, album, row.id, "resume");
      assert.equal(denied.status, 403, denied.data.error); assert.equal(session(ctx, row.id).status, "paused");
      const dismissed = await act(ctx, hq, album, row.id, "dismiss");
      assert.equal(dismissed.status, 200, dismissed.data.error); assert.equal(dismissed.data.status, "dismissed");
      await sleep(550);
      assert.equal(session(ctx, row.id).status, "dismissed", ctx.logs());
      assert.equal((await project(ctx, hq, album)).media.length, 0, "revoked uploader's derivative must never publish");
      assert.deepEqual(fs.readFileSync(tosFile(ctx, row.object_key)), source);
      const list = await ctx.api(`${albumRoute(album)}/media/upload-sessions`, { token: hq });
      assert.deepEqual(list.data.sessions, []);
    });
  }
});

test("persisted queued task resumes on process start without a client completion call", () => {
  const seeded = seededTasks("queued");
  return withServer({ seed: seeded.seed, beforeStart({ dir }) { writeObject({ dir }, seeded.objectKey, seeded.source); } }, async ctx => {
    const token = await ctx.login();
    const done = await until(() => status(ctx, token, seeded.album, seeded.id), r => ["completed", "delivery_failed"].includes(r.data.status), "startup queue did not finish");
    assert.equal(done.data.status, "completed", ctx.logs());
    const result = await project(ctx, token, seeded.album);
    assert.equal(result.media.length, 1); assert.equal(result.media[0].fingerprint, crypto.createHash("sha256").update(seeded.source).digest("hex"));
  });
});

test("complete uploaded source is automatically continued by background timer without client completion", () => {
  const seeded = seededTasks("uploading");
  return withServer({ seed: seeded.seed, beforeStart({ dir }) {
    // Only uploaded parts exist, not a merged source object: this reproduces a
    // browser that reached100 but never submitted POST /complete.
    fs.mkdirSync(path.join(dir, "tos"), { recursive: true });
    const source = tosFile({ dir }, seeded.objectKey);
    fs.writeFileSync(`${source}.part-1`, seeded.source);
    fs.writeFileSync(`${source}.parts.json`, JSON.stringify([{ PartNumber: 1, Size: seeded.source.length, ETag: "uploaded-part" }]));
  } }, async ctx => {
    const token = await ctx.login();
    assert.equal(session(ctx, seeded.id).status, "uploading");
    // GETs model a refreshed page; they must not need a repeat source upload or
    // POST /complete. The genuine production 15-second recovery timer does it.
    const done = await until(() => status(ctx, token, seeded.album, seeded.id), r => ["completed", "delivery_failed"].includes(r.data.status), "background recovery never continued ready source", 500);
    assert.equal(done.data.status, "completed", ctx.logs());
    assert.equal((await project(ctx, token, seeded.album)).media.length, 1);
  });
});

test("immediate resume after stopping a slow output preserves the new execution and publishes once", () => withServer({ tosDelay: 350 }, async ctx => {
  const token = await ctx.login(), album = await createAlbum(ctx, token), row = await initTask(ctx, token, album);
  const source = crypto.randomBytes(Number(row.file_size)); writeObject(ctx, row.object_key, source);
  assert.equal((await act(ctx, token, album, row.id, "resume")).status, 202);
  await until(() => status(ctx, token, album, row.id), r => r.data.progress?.stage === "uploading", "first execution never reached output upload");
  assert.equal((await act(ctx, token, album, row.id, "pause")).data.status, "paused");
  assert.equal((await act(ctx, token, album, row.id, "resume")).status, 202);
  const completed = await until(() => status(ctx, token, album, row.id), r => ["completed", "delivery_failed"].includes(r.data.status), "resumed execution failed to finish");
  assert.equal(completed.data.status, "completed", ctx.logs());
  const media = (await project(ctx, token, album)).media;
  assert.equal(media.length, 1); assert.equal(media[0].fingerprint, crypto.createHash("sha256").update(source).digest("hex"));
  assert.equal(session(ctx, row.id).status, "completed");
}));

test("startup recovery does not publish when the persisted uploader lost management role", () => {
  const seeded = seededTasks("queued"), user = JSON.parse(seeded.seed.users[0].doc);
  user.role = "viewer"; seeded.seed.users[0].role = "viewer"; seeded.seed.users[0].doc = JSON.stringify(user);
  return withServer({ seed: seeded.seed, beforeStart({ dir }) { writeObject({ dir }, seeded.objectKey, seeded.source); } }, async ctx => {
    const failed = await until(async () => session(ctx, seeded.id), r => r.status === "delivery_failed", "unauthorized queued task did not stop");
    assert.match(failed.error, /权限/);
    const saved = JSON.parse(ctx.persisted().activity_projects.find(r => r.id === seeded.album).doc);
    assert.equal(saved.media.length, 0); assert.ok(fs.existsSync(tosFile(ctx, seeded.objectKey)));
  });
});
