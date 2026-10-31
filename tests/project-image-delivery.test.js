const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
let validateProjectImage;
try {
  ({ validateProjectImage } = require("../server/project-image-delivery"));
} catch {}
const samples = {
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
  ),
  gif: Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  ),
  jpg: fs.readFileSync(
    path.join(__dirname, "../public/assets/people/cn-flower-salon.jpg"),
  ),
  webp: Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    "base64",
  ),
};
for (const [ext, bytes] of Object.entries(samples))
  test(`validates ${ext} actual structure and server SHA; rejects truncation/type/size`, async () => {
    assert.equal(
      typeof validateProjectImage,
      "function",
      "image validator is implemented",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-validate-")),
      file = path.join(dir, "image");
    try {
      fs.writeFileSync(file, bytes);
      const result = await validateProjectImage(file, {
        ext: "." + ext,
        expectedSize: bytes.length,
      });
      assert.equal(result.size, bytes.length);
      assert.equal(
        result.fingerprint,
        crypto.createHash("sha256").update(bytes).digest("hex"),
      );
      assert.equal(
        result.contentType,
        ext === "jpg" ? "image/jpeg" : `image/${ext}`,
      );
      await assert.rejects(
        validateProjectImage(file, { ext: "svg", expectedSize: bytes.length }),
      );
      await assert.rejects(
        validateProjectImage(file, { ext, expectedSize: bytes.length + 1 }),
      );
      fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
      await assert.rejects(
        validateProjectImage(file, {
          ext,
          expectedSize: fs.statSync(file).size,
        }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
test("aborted and empty photos never validate", async () => {
  assert.equal(typeof validateProjectImage, "function");
  const file = path.join(os.tmpdir(), `empty-photo-${process.pid}`);
  fs.writeFileSync(file, "");
  try {
    await assert.rejects(
      validateProjectImage(file, { ext: "png", expectedSize: 0 }),
    );
    const c = new AbortController();
    c.abort();
    await assert.rejects(
      validateProjectImage(file, {
        ext: "png",
        expectedSize: 1,
        signal: c.signal,
      }),
      {
        name: "AbortError",
      },
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
});
test("PNG chunk corruption and mismatched actual type cannot validate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-corrupt-")),
    file = path.join(dir, "image");
  try {
    const b = Buffer.from(samples.png);
    b[45] ^= 1;
    fs.writeFileSync(file, b);
    await assert.rejects(
      validateProjectImage(file, { ext: "png", expectedSize: b.length }),
    );
    fs.writeFileSync(file, samples.gif);
    await assert.rejects(
      validateProjectImage(file, {
        ext: "png",
        expectedSize: samples.gif.length,
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("same-size local file replacement between hash and final stat is rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-change-")),
    file = path.join(dir, "image");
  fs.writeFileSync(file, samples.png);
  const stat = fs.promises.stat;
  let reads = 0;
  fs.promises.stat = async function (target, ...args) {
    if (target === file && ++reads === 2) {
      const replacement = path.join(dir, "replacement");
      fs.writeFileSync(replacement, samples.png);
      fs.renameSync(replacement, file);
    }
    return stat.call(this, target, ...args);
  };
  try {
    await assert.rejects(
      validateProjectImage(file, {
        ext: "png",
        expectedSize: samples.png.length,
      }),
    );
  } finally {
    fs.promises.stat = stat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
