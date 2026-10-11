const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_DELIVERY_BYTES, assertSourceHash, assertDeliveryMedia, createCaseDirectDelivery } = require("../server/case-direct-delivery");

const validMedia = () => ({ type: "video", url: "https://media.example/delivery.mp4", poster: "https://media.example/first.jpg",
  size: 1000, fingerprint: "a".repeat(64), sourceSha256: "b".repeat(64) });
function harness(overrides = {}) {
  const events = [], tasks = [], media = validMedia();
  const session = { id: "case_upload_1234", case_id: "case_test", status: "uploading", source_sha256: media.sourceSha256 };
  let enabled = true, published = null;
  const deps = {
    enabled: () => enabled,
    readSession: async id => id === session.id ? { ...session } : null,
    updateSession: async (_id, fields) => { events.push(`status:${fields.status}`); Object.assign(session, fields); },
    listProcessing: async () => [session],
    schedule: task => tasks.push(task),
    assertCanPublish: () => events.push("permission"),
    ensureSource: async () => events.push("source"),
    prepare: async () => { events.push("process"); return { media, uploadedKeys: ["delivery", "poster"] }; },
    findPublished: async () => published,
    validate: async () => events.push("validate"),
    publish: async (_session, value) => { events.push("publish"); published = value; return value; },
    isPersisted: async () => { events.push("persisted"); return true; },
    deleteSource: async () => events.push("delete-source"),
    discard: async () => events.push("discard-delivery"),
    cleanup: async () => events.push("cleanup"),
    ...overrides
  };
  const service = createCaseDirectDelivery(deps);
  return { service, session, media, events, tasks, deps, setEnabled: value => { enabled = value; }, setPublished: value => { published = value; },
    complete: () => service.complete(session.case_id, session.id), drain: async () => { while (tasks.length) await tasks.shift()(); } };
}

test("strict delivery metadata and source hash", () => {
  assert.equal(assertDeliveryMedia(validMedia()).size, 1000);
  assert.doesNotThrow(() => assertSourceHash("b".repeat(64), "b".repeat(64)));
  assert.throws(() => assertSourceHash("a".repeat(64), "b".repeat(64)), /SHA-256/);
  assert.throws(() => assertSourceHash("b", "b"), /SHA-256/);
  for (const size of [0, -1, 1.5, MAX_DELIVERY_BYTES, 200 * 1024 * 1024, Infinity, "100"]) {
    assert.throws(() => assertDeliveryMedia({ ...validMedia(), size }));
  }
  for (const patch of [{ type: "link" }, { fingerprint: "forged" }, { sourceSha256: "" }, { poster: "" },
    { url: "http://media.example/a.mp4" }, { url: "https://media.example/a.mp4?signature=x" },
    { url: "https://media.example/a.mp4#t=1" }, { url: "https://user:pass@media.example/a.mp4" },
    { url: "https://media.example/a.mov" }, { poster: "https://media.example/first.png" }]) {
    assert.throws(() => assertDeliveryMedia({ ...validMedia(), ...patch }));
  }
});

test("complete only queues, validates before publication, deletes source after durable completion", async () => {
  const h = harness();
  assert.equal((await h.complete()).statusCode, 202);
  assert.equal(h.session.status, "processing");
  assert.equal(h.service.pendingCount(), 1);
  assert.ok(!h.events.includes("publish"));
  await h.drain();
  assert.equal(h.session.status, "completed");
  assert.equal(h.session.media_url, h.media.url);
  assert.equal(h.service.pendingCount(), 0);
  for (const [before, after] of [["source", "process"], ["process", "validate"], ["validate", "publish"], ["publish", "persisted"], ["persisted", "status:completed"], ["status:completed", "delete-source"]]) {
    assert.ok(h.events.indexOf(before) < h.events.indexOf(after), `${before} before ${after}`);
  }
});

test("concurrent complete serializes each request and merges the source once", async () => {
  const h = harness();
  const responses = await Promise.all([h.complete(), h.complete(), h.complete()]);
  assert.deepEqual(responses.map(result => result.statusCode), [202, 202, 202]);
  assert.equal(h.events.filter(event => event === "source").length, 1);
  assert.equal(h.tasks.length, 1);
  await h.drain();
  assert.equal(h.events.filter(event => event === "publish").length, 1);
});

test("complete and abort locks run their own actions in order", async () => {
  const h = harness();
  const first = h.complete();
  const abort = h.service.withLock(`${h.session.case_id}:${h.session.id}`, async () => {
    assert.equal(h.session.status, "processing");
    return { statusCode: 409, body: { error: "processing" } };
  });
  assert.equal((await first).statusCode, 202);
  assert.equal((await abort).statusCode, 409);
  const second = harness();
  const cancelled = second.service.withLock(`${second.session.case_id}:${second.session.id}`, async () => { second.session.status = "aborted"; return "own-result"; });
  const complete = second.complete();
  assert.equal(await cancelled, "own-result");
  await assert.rejects(complete, error => error.httpStatus === 409);
});

test("paused uploads never merge or publish an original", async () => {
  const h = harness();
  h.setEnabled(false);
  await assert.rejects(h.complete(), error => error.httpStatus === 503);
  assert.deepEqual(h.events, []);
  assert.equal(h.tasks.length, 0);
});

test("permission revocation while queued retains source and prevents publication", async () => {
  const h = harness();
  await h.complete();
  h.deps.assertCanPublish = () => { throw new Error("权限已变化"); };
  await h.drain();
  assert.equal(h.session.status, "delivery_failed");
  assert.ok(!h.events.includes("process"));
  assert.ok(!h.events.includes("publish"));
  assert.ok(!h.events.includes("delete-source"));
});

test("pause or case removal after object validation still prevents cache mutation", async () => {
  for (const reason of ["pause", "case-removed"]) {
    const h = harness();
    h.deps.validate = async () => {
      if (reason === "pause") h.setEnabled(false);
      else h.deps.assertCanPublish = () => { throw new Error("案例已删除"); };
    };
    await h.complete();
    await h.drain();
    assert.equal(h.session.status, "delivery_failed");
    assert.ok(!h.events.includes("publish"));
    assert.ok(h.events.includes("discard-delivery"));
    assert.ok(!h.events.includes("delete-source"));
  }
});

for (const [name, override] of [
  ["source hash or transcode failure", { prepare: async () => { throw new Error("SHA-256 不一致"); } }],
  ["actual object or poster HEAD mismatch", { validate: async () => { throw new Error("对象大小不一致"); } }],
  ["malformed delivery metadata", { prepare: async () => ({ media: { ...validMedia(), size: MAX_DELIVERY_BYTES } }) }]
]) test(`${name} retains source and cannot mutate media`, async () => {
  const h = harness(override);
  await h.complete();
  await h.drain();
  assert.equal(h.session.status, "delivery_failed");
  assert.ok(!h.events.includes("publish"));
  assert.ok(!h.events.includes("delete-source"));
});

test("publish/persistence failure retains both source and any cache-referenced output", async () => {
  for (const override of [{ publish: async () => { throw new Error("数据库写入失败"); } }, { isPersisted: async () => false }]) {
    const h = harness(override);
    await h.complete();
    await h.drain();
    assert.equal(h.session.status, "delivery_failed");
    assert.ok(!h.events.includes("delete-source"));
    assert.ok(!h.events.includes("discard-delivery"));
  }
});

test("validation failure discards only unreferenced deliveries", async () => {
  const h = harness({ validate: async () => { throw new Error("封面不符合要求"); } });
  await h.complete();
  await h.drain();
  assert.ok(h.events.includes("discard-delivery"));
  assert.ok(!h.events.includes("delete-source"));
});

test("delivery_failed retries through source validation and one shared queue", async () => {
  const h = harness();
  h.session.status = "delivery_failed";
  assert.equal((await h.complete()).statusCode, 202);
  await h.drain();
  assert.equal(h.session.status, "completed");
  assert.ok(h.events.includes("source"));
});

test("restart recovery validates persisted delivery before reusing it", async () => {
  const h = harness();
  h.session.status = "processing";
  h.setPublished(h.media);
  await h.service.resume();
  await h.service.resume();
  assert.equal(h.tasks.length, 1);
  await h.drain();
  assert.equal(h.session.status, "completed");
  assert.ok(h.events.includes("validate"));
  assert.ok(!h.events.includes("process"));
});

test("paused restart marks processing retryable without touching the source", async () => {
  const h = harness();
  h.session.status = "processing";
  h.setEnabled(false);
  await h.service.resume();
  assert.equal(h.session.status, "delivery_failed");
  assert.equal(h.tasks.length, 0);
  assert.ok(!h.events.includes("delete-source"));
});

test("source cleanup failure cannot undo a durably completed delivery", async () => {
  const h = harness({ deleteSource: async () => { throw new Error("TOS cleanup unavailable"); } });
  await h.complete();
  await h.drain();
  assert.equal(h.session.status, "completed");
  assert.ok(!h.events.includes("discard-delivery"));
});

test("completed response requires a valid persisted delivery, never falls back to source", async () => {
  const h = harness();
  h.session.status = "completed";
  await assert.rejects(h.complete(), error => error.httpStatus === 409);
  h.setPublished(h.media);
  assert.equal((await h.complete()).statusCode, 200);
  assert.equal(h.tasks.length, 0);
  assert.ok(!h.events.includes("source"));
});

test("invalid case/session and aborted sessions cannot queue", async () => {
  const h = harness();
  await assert.rejects(h.service.complete("other-case", h.session.id), error => error.httpStatus === 404);
  await assert.rejects(h.service.complete(h.session.case_id, "missing"), error => error.httpStatus === 404);
  h.session.status = "aborted";
  await assert.rejects(h.complete(), error => error.httpStatus === 409);
  assert.equal(h.tasks.length, 0);
});

test("capacity reservation exists before source await and is released on failure", async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = harness({ ensureSource: async () => { await wait; throw new Error("分片不完整"); } });
  h.deps.assertCapacity = () => assert.equal(h.service.pendingCount(), 0);
  const complete = h.complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.pendingCount(), 1);
  release();
  await assert.rejects(complete);
  assert.equal(h.service.pendingCount(), 0);
  assert.equal(h.session.status, "failed");
});

test("full queue refuses before source merge; processing retry does not need another slot", async () => {
  const h = harness({ assertCapacity: () => { throw Object.assign(new Error("队列已满"), { httpStatus: 429 }); } });
  await assert.rejects(h.complete(), error => error.httpStatus === 429);
  assert.ok(!h.events.includes("source"));
  assert.equal(h.service.pendingCount(), 0);
  h.session.status = "processing";
  assert.equal((await h.complete()).statusCode, 202);
  assert.equal(h.service.pendingCount(), 1);
});
