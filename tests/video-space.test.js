const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVideoSpaceReservations } = require("../server/video-space");

test("concurrent equal budgets cannot overbook across receiver directories", async () => {
  let checks = 0, concurrent = 0, peak = 0;
  const space = createVideoSpaceReservations({ available: async () => {
    checks++; concurrent++; peak = Math.max(peak, concurrent);
    await new Promise(resolve => setImmediate(resolve));
    concurrent--;
    return 1000;
  } });
  const results = await Promise.allSettled([space.reserve("receiver-a", 600), space.reserve("worker-b", 600)]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(results[1].reason.code, "VIDEO_SPACE_LOW");
  assert.equal(checks, 2);
  assert.equal(peak, 1, "free-space checks are serialized through their await");
  results[0].value();
  (await space.reserve("worker-b", 1000))();
});

test("exact available budget is accepted and release is idempotent", async () => {
  const space = createVideoSpaceReservations({ available: async () => 1000 });
  const release = await space.reserve("stage", 1000);
  await assert.rejects(space.reserve("stage", 1), { code: "VIDEO_SPACE_LOW" });
  release(); release(); release();
  const next = await space.reserve("stage", 1000);
  await assert.rejects(space.reserve("stage", 1), { code: "VIDEO_SPACE_LOW" });
  next();
});

test("refused reservations do not occupy capacity or poison later requests", async () => {
  let free = 100;
  const space = createVideoSpaceReservations({ available: async () => free });
  await assert.rejects(space.reserve("stage", 101), { code: "VIDEO_SPACE_LOW" });
  const release = await space.reserve("stage", 100);
  release();
  free = 1000;
  (await space.reserve("stage", 1000))();
});

test("available exceptions propagate without leaving a reservation or a broken queue", async () => {
  let failure = true;
  const expected = new Error("statfs failed");
  const space = createVideoSpaceReservations({ available: async () => {
    if (failure) throw expected;
    return 1000;
  } });
  await assert.rejects(space.reserve("stage", 1000), error => error === expected);
  failure = false;
  (await space.reserve("stage", 1000))();
});

test("malformed budgets and free-space readings are rejected", async () => {
  let checks = 0;
  const space = createVideoSpaceReservations({ available: async () => { checks++; return 1000; } });
  for (const budget of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"]) {
    await assert.rejects(space.reserve("stage", budget), TypeError);
  }
  for (const directory of ["", "  ", null, 123]) await assert.rejects(space.reserve(directory, 1), TypeError);
  assert.equal(checks, 0);
  for (const free of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    const invalid = createVideoSpaceReservations({ available: async () => free });
    await assert.rejects(invalid.reserve("stage", 1), { code: "VIDEO_SPACE_CHECK_FAILED" });
  }
  assert.throws(() => createVideoSpaceReservations({ available: 1 }), TypeError);
});

test("real free space falling while another lease exists is deducted conservatively", async () => {
  let free = 1000;
  const space = createVideoSpaceReservations({ available: async () => free });
  const release = await space.reserve("stage", 600);
  free = 700;
  await assert.rejects(space.reserve("stage", 101), { code: "VIDEO_SPACE_LOW" });
  const small = await space.reserve("stage", 100);
  release();
  small();
  (await space.reserve("stage", 700))();
});

test("release during a free-space check cannot make an older sample over-admit", async () => {
  let finish, checks = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const space = createVideoSpaceReservations({ available: async () => ++checks === 2 ? pending : 1000 });
  const release = await space.reserve("stage", 600);
  const next = space.reserve("stage", 600);
  await new Promise(resolve => setImmediate(resolve));
  release();
  finish(1000);
  await assert.rejects(next, { code: "VIDEO_SPACE_LOW" });
  (await space.reserve("stage", 1000))();
});

test("default available uses actual filesystem stats and does not create directories", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-video-space-"));
  try {
    const space = createVideoSpaceReservations();
    (await space.reserve(dir, 1))();
    const missing = path.join(dir, "not-created");
    await assert.rejects(space.reserve(missing, 1), error => error.code === "ENOENT");
    assert.equal(fs.existsSync(missing), false);
    (await space.reserve(dir, 1))();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
