"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest, candidate } = require("../ops/cleanup-shaoxing-originals");

const id = "project_85aae4b746069044";
const original = index => ({ index, type: "video", url: `https://proj2.likeduoduiyi.cn/silver-project-videos/original-${index}.mov` });
const manifest = () => Array.from({ length: 36 }, (_, i) => original(i + 1));
const uploaded = () => {
  const stem = `project_${id}_1_${"a".repeat(12)}`;
  return {
    phase: "uploaded", index: 1, url: `https://proj2.likeduoduiyi.cn/silver-project-videos/${stem}.mp4`,
    poster: `https://proj2.likeduoduiyi.cn/silver-project-images/${stem}_poster.jpg`,
    sourceSize: 1000, sourceHash: "a".repeat(64), size: 300, posterSize: 40,
    fingerprint: "b".repeat(64), duration: 12
  };
};
const published = u => ({ phase: "published", index: 1, url: u.url, poster: u.poster,
  sourceSize: u.sourceSize, size: u.size, posterSize: u.posterSize });

test("only the frozen 36 unique Shaoxing video objects are eligible", () => {
  assert.equal(validateManifest(manifest()).length, 36);
  assert.throws(() => validateManifest(manifest().slice(0, 35)));
  const duplicate = manifest(); duplicate[35].url = duplicate[0].url;
  assert.throws(() => validateManifest(duplicate));
  const foreign = manifest(); foreign[0].url = "https://example.com/a.mov";
  assert.throws(() => validateManifest(foreign));
});

test("publication plus matching upload are both required", () => {
  const u = uploaded();
  assert.equal(candidate(original(1), [u]), null);
  assert.throws(() => candidate(original(1), [published(u)]));
  assert.equal(candidate(original(1), [u, published(u)]).uploaded, u);
});

test("identical retry is valid, divergent retry and mismatched poster fail closed", () => {
  const u = uploaded();
  assert.equal(candidate(original(1), [u, { ...u }, published(u)]).uploaded, u);
  assert.throws(() => candidate(original(1), [u, { ...u, size: 301 }, published(u)]));
  assert.throws(() => candidate(original(1), [u, { ...published(u), poster: "https://example.com/wrong.jpg" }]));
});

test("target key must derive from the exact source SHA and index", () => {
  const u = uploaded();
  assert.throws(() => candidate(original(1), [{ ...u, sourceHash: "c".repeat(64) }, published(u)]));
  assert.throws(() => candidate(original(1), [{ ...u, url: original(1).url }, { ...published(u), url: original(1).url }]));
});
