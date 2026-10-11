const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_DELIVERY_BYTES, trustedObjectKey, canonicalVideoReferences } = require("../server/video-publication");
const video = { type: "video", url: "https://media.test/videos/a.mp4", size: 10000, fingerprint: "a".repeat(64), poster: "https://media.test/images/a.jpg" };

test("client size, poster and SHA cannot make an arbitrary URL a ready asset", () => {
  assert.throws(() => canonicalVideoReferences([video]), /不能直接登记/);
  assert.throws(() => canonicalVideoReferences([video], { ready: [{ ...video, size: MAX_DELIVERY_BYTES }] }), /成片校验/);
  assert.throws(() => canonicalVideoReferences([video], { ready: [{ ...video, poster: "" }] }), /成片校验/);
  assert.throws(() => canonicalVideoReferences([{ ...video, type: "link" }]), /视频文件/);
  assert.throws(() => canonicalVideoReferences([{ ...video, type: "image" }]), /视频文件/);
});
test("ready records supply canonical metadata; captions remain editable", () => {
  const { media, checks } = canonicalVideoReferences([{ ...video, size: 1, poster: "https://evil.test/a.jpg", caption: "new" }], { ready: [video] });
  assert.equal(media[0].size, video.size);
  assert.equal(media[0].poster, video.poster);
  assert.equal(media[0].caption, "new");
  assert.equal(checks.length, 1);
});
test("unchanged legacy video can be edited, but new publication must satisfy the standard", () => {
  const old = { type: "video", url: video.url, size: 300000000 };
  assert.equal(canonicalVideoReferences([{ ...old, size: 1 }], { existing: [old] }).media[0].size, old.size);
  assert.throws(() => canonicalVideoReferences([old], { existing: [old], requireAll: true }), /成片校验/);
});
test("storage keys require the exact configured public URL, no host tricks or traversal", () => {
  const locations = [["https://media.test/videos", "videos"]];
  assert.equal(trustedObjectKey(video.url, locations), "videos/a.mp4");
  for (const bad of ["https://evil.test/videos/a.mp4", "https://media.test/videos/a.mp4?x=1", "https://media.test/videos/%2e%2e", "https://media.test/videos/a%2Fb.mp4", "https://media.test/videos/a.mp4#x"]) {
    assert.equal(trustedObjectKey(bad, locations), "", bad);
  }
});
