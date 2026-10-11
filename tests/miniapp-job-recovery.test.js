"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

// Execute the actual server lifecycle functions without starting DB/TOS/network.
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const saveAndWorker = source.slice(source.indexOf("function saveMiniappJobs("), source.indexOf("\nfunction enqueueProjectVideoDelivery("));
const resume = source.slice(source.indexOf("async function resumeMiniappJobs()"), source.indexOf("\nfunction mysqlDateFromSeconds("));
const publication = source.slice(source.indexOf("function commitActivityProject("), source.indexOf("\nfunction publicProject("));

function context(t, { failReady = false, holdRename = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-job-recovery-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "jobs.json");
  const ctx = {
    fs: { ...fs, promises: { ...fs.promises,
      writeFile: async (name, content, options) => {
        if (failReady && JSON.parse(content).some(job => job.status === "ready")) throw Object.assign(new Error("simulated disk failure"), { code: "EIO" });
        return fs.promises.writeFile(name, content, options);
      },
      rename: async (...args) => { if (holdRename) await holdRename(); return fs.promises.rename(...args); }
    } }, path, MINIAPP_STAGE_DIR: dir, MINIAPP_JOBS_FILE: file,
    MINIAPP_MAX_VIDEO_BYTES: 190 * 1024 * 1024,
    _miniappJobs: new Map(), _miniappJobWrites: Promise.resolve(), _miniappQueue: Promise.resolve(), _persistedSnapshot: null,
    H5_AUTO_VIDEO_DELIVERY: true, now: () => new Date().toISOString(),
    console: { error() {} }, videoSpace: { reserve: async () => () => {} },
    processMiniappVideo: async () => 1000, processVideoPoster: async () => 100,
    hashFileSHA256: async () => "a".repeat(64),
    readDb: () => ({ users: [{ id: "admin", role: "admin", status: "active" }] }),
    caseVideoTosObject: () => ({ key: "video.mp4" }),
    uploadCaseVideoToTos: async () => "https://example.com/video.mp4",
    uploadImageFileToTos: async () => "https://example.com/poster.jpg",
    getCaseVideoTosClient: () => ({ client: { headObject: async () => ({}), deleteObject: async () => {} }, bucket: "test" }),
    assertTosObjectSize() {}, verifyPublishedVideo: async () => {}, CASE_IMAGE_TOS_PREFIX: "images"
  };
  vm.createContext(ctx);
  vm.runInContext(saveAndWorker + "\n" + resume + "\n" + publication, ctx);
  return { ctx, dir, file };
}

test("restart turns persisted receiving jobs into failed and frees all six queue slots", async t => {
  const { ctx, dir, file } = context(t);
  const jobs = Array.from({ length: 6 }, (_, index) => ({ id: "miniapp_" + String(index).padStart(24, "0"), status: "receiving" }));
  for (const job of jobs) { fs.mkdirSync(path.join(dir, job.id)); fs.writeFileSync(path.join(dir, job.id, "source"), "incomplete"); }
  fs.writeFileSync(file, JSON.stringify(jobs));
  await vm.runInContext("resumeMiniappJobs()", ctx);
  assert.equal([...ctx._miniappJobs.values()].filter(job => ["receiving", "queued", "processing"].includes(job.status)).length, 0);
  for (const job of ctx._miniappJobs.values()) { assert.equal(job.status, "failed"); assert.match(job.error, /重新选择/); assert.equal(fs.existsSync(path.join(dir, job.id)), false); }
  assert.ok(JSON.parse(fs.readFileSync(file)).every(job => job.status === "failed"));
});

test("ready is not visible until the ready record has been renamed successfully", async t => {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { ctx, file } = context(t, { holdRename: async () => { entered(); await wait; } });
  const job = { id: "miniapp_" + "a".repeat(24), status: "processing" };
  ctx._miniappJobs.set(job.id, job);
  const saving = ctx.saveMiniappJobs({ ...job, status: "ready" });
  await started;
  assert.equal(job.status, "processing");
  assert.equal(fs.existsSync(file), false);
  release(); await saving;
  assert.equal(job.status, "ready");
  assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "ready");
});

test("ready persistence failure marks worker failed and retains its retry source", async t => {
  const { ctx, dir, file } = context(t, { failReady: true });
  const job = { id: "miniapp_" + "b".repeat(24), kind: "case-admin", uploadedBy: "admin", status: "queued" };
  ctx._miniappJobs.set(job.id, job);
  fs.mkdirSync(path.join(dir, job.id)); fs.writeFileSync(path.join(dir, job.id, "source"), "original");
  ctx.enqueueMiniappVideo(job);
  await vm.runInContext("_miniappQueue", ctx);
  assert.equal(job.status, "failed");
  assert.match(job.error, /simulated disk failure/);
  assert.equal(fs.readFileSync(path.join(dir, job.id, "source"), "utf8"), "original");
  assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "failed");
});

test("queued serialized saves take current state, preserving a completed ready transition", async t => {
  const { ctx, file } = context(t);
  const job = { id: "miniapp_" + "c".repeat(24), status: "processing" };
  ctx._miniappJobs.set(job.id, job);
  await Promise.all([ctx.saveMiniappJobs({ ...job, status: "ready" }), ctx.saveMiniappJobs()]);
  assert.equal(job.status, "ready");
  assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "ready");
});

test("successful worker cleans staging only after a readable ready job record exists", async t => {
  const { ctx, dir, file } = context(t);
  const job = { id: "miniapp_" + "e".repeat(24), kind: "case-admin", uploadedBy: "admin", status: "queued" };
  ctx._miniappJobs.set(job.id, job);
  const stage = path.join(dir, job.id);
  fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, "source"), "original");
  let cleaned = false;
  ctx.fs.promises.rm = async (name, options) => {
    assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "ready");
    cleaned = true;
    return fs.promises.rm(name, options);
  };
  ctx.enqueueMiniappVideo(job);
  await vm.runInContext("_miniappQueue", ctx);
  assert.equal(job.status, "ready");
  assert.equal(cleaned, true);
  assert.equal(fs.existsSync(stage), false);
});

test("native worker DB failure stays unpublished/failed with source, then retries to ready once", async t => {
  const { ctx, dir, file } = context(t);
  const job = { id: "miniapp_" + "f".repeat(24), projectId: "project_test", ownerId: "owner", uploadedBy: "admin", status: "queued" };
  const db = { users: [{ id: "admin", role: "admin", status: "active" }], activityProjects: [{ id: "project_test", ownerId: "owner", title: "album", media: [] }] };
  let stored = JSON.parse(JSON.stringify(db.activityProjects)), pending, failCommit = true;
  const conn = {
    async beginTransaction() { pending = JSON.parse(JSON.stringify(stored)); },
    async query(_sql, values) { pending[0] = JSON.parse(values[5]); },
    async commit() { if (failCommit) { failCommit = false; throw new Error("simulated album DB failure"); } stored = pending; },
    async rollback() { pending = null; }, release() {}
  };
  Object.assign(ctx, {
    readDb: () => db, pool: { getConnection: async () => conn }, _writeQueue: Promise.resolve(),
    normalizeActivityProject: value => JSON.parse(JSON.stringify(value)), projectCanManage: () => true,
    uploadProjectFileToTos: async (_filename, name) => `https://example.com/${name}`, projectTosObjectKey: url => url
  });
  ctx._miniappJobs.set(job.id, job);
  const stage = path.join(dir, job.id);
  fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, "source"), "original");
  ctx.enqueueMiniappVideo(job); await vm.runInContext("_miniappQueue", ctx);
  assert.equal(job.status, "failed"); assert.match(job.error, /album DB failure/);
  assert.equal(db.activityProjects[0].media.length, 0); assert.equal(stored[0].media.length, 0);
  assert.equal(fs.readFileSync(path.join(stage, "source"), "utf8"), "original");
  assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "failed");
  job.status = "queued";
  ctx.enqueueMiniappVideo(job); await vm.runInContext("_miniappQueue", ctx);
  assert.equal(job.status, "ready");
  assert.equal(db.activityProjects[0].media.length, 1); assert.equal(stored[0].media.length, 1);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(JSON.parse(fs.readFileSync(file))[0].status, "ready");
});
