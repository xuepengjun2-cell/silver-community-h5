"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const publication = source.slice(source.indexOf("function commitActivityProject("), source.indexOf("\nfunction publicProject("));
const write = source.slice(source.indexOf("async function writeDb()"), source.indexOf("\nfunction readSiteConfig("));
const clone = value => JSON.parse(JSON.stringify(value));
const video = { type: "video", url: "https://example.com/new.mp4", poster: "https://example.com/new.jpg", size: 1000, fingerprint: "a".repeat(64), title: "活动视频", caption: "", createdAt: "2026-10-11" };
const photo = name => ({ type: "image", url: `https://example.com/${name}.jpg`, title: name });

function fixture() {
  const db = { activityProjects: [{ id: "project_test", ownerId: "owner", title: "original title", media: [photo("original")] }] };
  let stored = clone(db.activityProjects), pending;
  const control = { failCommit: false, beforeCommit: null, begins: 0, rollbacks: 0 };
  const conn = {
    async beginTransaction() { control.begins++; pending = clone(stored); },
    async query(sql, values) {
      if (sql.startsWith("INSERT INTO activity_projects")) {
        const row = JSON.parse(values[5]), index = pending.findIndex(item => item.id === row.id);
        if (index < 0) pending.push(row); else pending[index] = row;
      } else if (sql.startsWith("DELETE FROM activity_projects WHERE id = ?")) pending = pending.filter(row => row.id !== values[0]);
      else throw new Error("Unexpected SQL in native-only transaction");
      return [[], []];
    },
    async commit() {
      if (control.beforeCommit) { const hook = control.beforeCommit; control.beforeCommit = null; await hook(); }
      if (control.failCommit) { control.failCommit = false; throw new Error("simulated DB commit failure"); }
      stored = pending; pending = null;
    },
    async rollback() { control.rollbacks++; pending = null; },
    release() {}
  };
  const ctx = {
    _writeQueue: Promise.resolve(), _persistedSnapshot: { activityProjects: clone(db.activityProjects) }, readDb: () => db,
    persistDb: async () => {
      // Match the application's incremental comparison rather than pretending
      // every normal write always rewrites every unchanged row.
      stored = stored.filter(row => db.activityProjects.some(item => item.id === row.id));
      for (const row of db.activityProjects) {
        const previous = ctx._persistedSnapshot.activityProjects.find(item => item.id === row.id);
        if (JSON.stringify(previous) === JSON.stringify(row)) continue;
        const index = stored.findIndex(item => item.id === row.id);
        if (index < 0) stored.push(clone(row)); else stored[index] = clone(row);
      }
      ctx._persistedSnapshot.activityProjects = clone(db.activityProjects);
    },
    pool: { getConnection: async () => conn },
    normalizeActivityProject: next => clone(next), now: () => "2026-10-11T12:00:00Z"
  };
  vm.createContext(ctx); vm.runInContext(publication + "\n" + write, ctx);
  const owner = current => { if (!current || current.ownerId !== "owner") throw new Error("album deleted or transferred"); };
  return { ctx, db, control, stored: () => stored, publish: () => ctx.publishNativeProjectVideo("project_test", video, owner) };
}

test("failed DB commit never exposes video, and the following normal write cannot persist a ghost", async () => {
  const f = fixture(); let normalWrite;
  f.control.failCommit = true;
  f.control.beforeCommit = () => {
    assert.equal(f.db.activityProjects[0].media.some(item => item.type === "video"), false, "public/manage cache stays unpublished during SQL");
    f.db.activityProjects[0].title = "concurrent title";
    f.db.activityProjects[0].media.push(photo("concurrent"));
    normalWrite = f.ctx.writeDb();
  };
  await assert.rejects(f.publish(), /simulated DB commit failure/);
  await normalWrite;
  assert.equal(f.control.rollbacks, 1);
  for (const row of [f.db.activityProjects[0], f.stored()[0]]) {
    assert.equal(row.title, "concurrent title");
    assert.deepEqual(row.media.map(item => item.title), ["original", "concurrent"]);
  }
});

test("successful commit merges only the video into latest title/photos before later queued persistence", async () => {
  const f = fixture(); let normalWrite;
  f.control.beforeCommit = () => {
    assert.equal(f.db.activityProjects[0].media.length, 1);
    f.db.activityProjects[0] = { ...f.db.activityProjects[0], title: "new title", shareEnabled: false, media: [...f.db.activityProjects[0].media, photo("new photo")] };
    f.db.activityProjects.unshift({ id: "project_other", title: "other album", media: [] });
    normalWrite = f.ctx.writeDb();
  };
  await f.publish(); await normalWrite;
  for (const rows of [f.db.activityProjects, f.stored()]) {
    assert.equal(rows.length, 2);
    const row = rows.find(item => item.id === "project_test");
    assert.equal(row.title, "new title"); assert.equal(row.shareEnabled, false);
    assert.deepEqual(row.media.map(item => item.title), ["original", "new photo", "活动视频"]);
  }
});

test("a failed publication can retry successfully and repeated retries preserve captions without duplicates", async () => {
  const f = fixture(); f.control.failCommit = true;
  await assert.rejects(f.publish(), /DB commit failure/);
  assert.equal(f.db.activityProjects[0].media.length, 1);
  await f.publish();
  const ready = f.db.activityProjects[0].media.find(item => item.type === "video");
  ready.title = "user title"; ready.caption = "user caption"; ready.createdAt = "original creation";
  await f.publish();
  assert.equal(f.db.activityProjects[0].media.filter(item => item.type === "video").length, 1);
  const retried = f.db.activityProjects[0].media.find(item => item.type === "video");
  assert.equal(retried.title, "user title"); assert.equal(retried.caption, "user caption"); assert.equal(retried.createdAt, "original creation");
  assert.equal(f.stored()[0].media.filter(item => item.type === "video").length, 1);
});

test("album deletion during SQL is not resurrected in cache or DB", async () => {
  const f = fixture();
  f.control.beforeCommit = () => { f.db.activityProjects.splice(0, 1); };
  await assert.rejects(f.publish(), /deleted or transferred/);
  assert.equal(f.db.activityProjects.length, 0); assert.equal(f.stored().length, 0);
  assert.equal(f.control.begins, 2, "candidate is removed before releasing the write queue");
  await f.ctx.writeDb(); assert.equal(f.stored().length, 0);
});

test("ownership change during SQL keeps the latest owner, title and photos without publishing the candidate", async () => {
  const f = fixture();
  f.control.beforeCommit = () => {
    f.db.activityProjects[0].ownerId = "new owner"; f.db.activityProjects[0].title = "new owner title";
    f.db.activityProjects[0].media.push(photo("new owner photo"));
  };
  await assert.rejects(f.publish(), /deleted or transferred/);
  for (const row of [f.db.activityProjects[0], f.stored()[0]]) {
    assert.equal(row.ownerId, "new owner"); assert.equal(row.title, "new owner title");
    assert.equal(row.media.length, 2); assert.equal(row.media.some(item => item.type === "video"), false);
  }
});

test("authorization is checked before any candidate SQL is attempted", async () => {
  const f = fixture(); f.db.activityProjects[0].ownerId = "someone else";
  await assert.rejects(f.publish(), /deleted or transferred/);
  assert.equal(f.control.begins, 0);
  assert.equal(f.stored()[0].media.length, 1);
});

test("removing a just-published video back to the original row still updates SQL", async () => {
  const f = fixture(), original = clone(f.db.activityProjects[0]);
  await f.publish();
  assert.equal(f.stored()[0].media.filter(item => item.type === "video").length, 1);
  assert.equal(f.ctx._persistedSnapshot.activityProjects[0].media.filter(item => item.type === "video").length, 1);
  f.db.activityProjects[0] = original;
  await f.ctx.writeDb();
  assert.equal(f.stored()[0].media.some(item => item.type === "video"), false);
});
