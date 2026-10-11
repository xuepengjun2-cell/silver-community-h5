const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { withServer, sleep, CASE_T, SYNC_TOKEN } = require("./support/video-api-server");
const video = { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/fake.mp4", size: 100, poster: "https://proj2.likeduoduiyi.cn/silver-images/fake.jpg", fingerprint: "a".repeat(64) };
const album = async (ctx, token) => (await ctx.api("/my/activity-projects", { method: "POST", token, body: { title: "测试相册" } })).data.project.id;

test("processing disabled closes admin, multipart, native and automation video paths", () => withServer({ env: { H5_AUTO_VIDEO_DELIVERY: "0" } }, async ctx => {
  const token = await ctx.login();
  const id = await album(ctx, token);
  const calls = [
    ctx.api("/admin/upload-video?delivery=1&ext=mp4", { method: "POST", token, raw: Buffer.alloc(4) }),
    ctx.api(`/my/activity-projects/${id}/media/init`, { method: "POST", token, body: { type: "video", ext: "mp4", size: 1024 } }),
    ctx.api(`/my/activity-projects/${id}/miniapp-media?type=video`, { method: "POST", token, raw: Buffer.alloc(4) }),
    ctx.api(`/automation/cases/${CASE_T}/videos/init`, { method: "POST", headers: { Authorization: `Bearer ${SYNC_TOKEN}` }, body: {} })
  ];
  assert.deepEqual((await Promise.all(calls)).map(x => x.status), [503, 503, 503, 503]);
  assert.equal((await ctx.api(`/my/activity-projects/${id}/media?type=video&ext=mp4`, { method: "POST", token, raw: Buffer.alloc(4) })).status, 409);
  assert.equal((await ctx.api(`/my/activity-projects/${id}`, { token })).data.project.media.length, 0);
}));

test("fake client URL, size and SHA cannot inject a video into an album or case", () => withServer({}, async ctx => {
  const token = await ctx.login();
  assert.equal((await ctx.api("/my/activity-projects", { method: "POST", token, body: { title: "伪造相册", media: [video] } })).status, 422);
  assert.equal((await ctx.api("/admin/cases", { method: "POST", token, body: { title: "伪造案例", status: "draft", media: [video] } })).status, 422);
  assert.equal((await ctx.api("/admin/cases", { method: "POST", token, body: { title: "类型伪装", media: [{ ...video, type: "link" }] } })).status, 422);
  const created = await ctx.api("/admin/cases", { method: "POST", token, body: { title: "正常案例" } });
  assert.equal(created.status, 201);
  assert.equal((await ctx.api(`/admin/cases/${created.data.case.id}`, { method: "PATCH", token, body: { media: [video] } })).status, 422);
  assert.equal((await ctx.api("/admin/cases", { token })).data.cases.find(x => x.id === created.data.case.id).media.length, 0);
}));

test("only server-ready metadata is accepted and a failed processor never publishes", () => withServer({}, async ctx => {
  const token = await ctx.login();
  const uploaded = await ctx.api("/admin/upload-video?delivery=1&ext=mov", { method: "POST", token, raw: crypto.randomBytes(4000) });
  assert.equal(uploaded.status, 202);
  let job;
  for (let i = 0; i < 60; i++) {
    job = (await ctx.api(`/admin/video-jobs/${uploaded.data.jobId}`, { token })).data;
    if (["ready", "failed"].includes(job.status)) break;
    await sleep(50);
  }
  assert.equal(job.status, "ready", job.error);
  const created = await ctx.api("/admin/cases", { method: "POST", token, body: { title: "验证案例", media: [{ ...job, type: "video", size: 1, poster: "https://evil.test/a.jpg" }] } });
  assert.equal(created.status, 201, created.data.error);
  assert.equal(created.data.case.media[0].size, job.size);
  assert.equal(created.data.case.media[0].poster, job.poster);
}));

test("transcoding failure leaves a retryable source and no published case asset", () => withServer({ env: { FAKE_MEDIA_FAIL: "1" } }, async ctx => {
  const fs = require("node:fs"), path = require("node:path");
  const token = await ctx.login();
  const uploaded = await ctx.api("/admin/upload-video?delivery=1&ext=mp4", { method: "POST", token, raw: crypto.randomBytes(4000) });
  let job;
  for (let i = 0; i < 60; i++) {
    job = (await ctx.api(`/admin/video-jobs/${uploaded.data.jobId}`, { token })).data;
    if (job.status === "failed") break;
    await sleep(50);
  }
  assert.equal(job.status, "failed");
  assert.equal(job.url, undefined);
  assert.ok(fs.existsSync(path.join(ctx.dir, "data/.miniapp-upload-staging", uploaded.data.jobId, "source")));
  assert.equal((await ctx.api(`/admin/video-jobs/${uploaded.data.jobId}/retry`, { method: "POST", token, body: {} })).status, 202);
}));

test("disabled multipart completion cannot register an already uploaded original", () => {
  const id = "project_old", sessionId = "project_upload_1234";
  return withServer({ env: { H5_AUTO_VIDEO_DELIVERY: "0" }, seed: {
    users: [{ id: "u_admin", username: "admin", role: "admin", status: "active", doc: JSON.stringify({ id: "u_admin", username: "admin", role: "admin", status: "active", salt: "demo-admin", passwordHash: crypto.createHash("sha256").update("demo-admin:admin123").digest("hex") }) }],
    activity_projects: [{ id, owner_id: "u_admin", title: "旧相册", status: "published", doc: JSON.stringify({ id, title: "旧相册", ownerId: "u_admin", status: "published", media: [] }) }],
    project_upload_sessions: [{ id: sessionId, project_id: id, owner_id: "u_admin", status: "uploading", file_size: 300000000, part_size: 16777216, part_count: 18, filename: "original.mp4", object_key: "silver-project-videos/original.mp4", upload_id: "test" }]
  } }, async ctx => {
    const token = await ctx.login();
    const completed = await ctx.api(`/my/activity-projects/${id}/media/upload-session/${sessionId}/complete?delivery=1`, { method: "POST", token, body: {} });
    assert.equal(completed.status, 503, completed.data.error);
    assert.equal((await ctx.api(`/my/activity-projects/${id}`, { token })).data.project.media.length, 0);
  });
});

test("native videos share the global six-task gate", () => withServer({ tosDelay: 500 }, async ctx => {
  const token = await ctx.login(), id = await album(ctx, token);
  const upload = () => {
    const form = new FormData(); form.append("media", new Blob([crypto.randomBytes(4000)]), "test.mp4");
    return ctx.api(`/my/activity-projects/${id}/miniapp-media?type=video`, { method: "POST", token, raw: form });
  };
  assert.deepEqual((await Promise.all(Array.from({ length: 6 }, upload))).map(x => x.status), Array(6).fill(202));
  assert.equal((await upload()).status, 429);
}));
