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

function webpChunk(type, payload) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    header,
    payload,
    ...(payload.length % 2 ? [Buffer.from([0])] : []),
  ]);
}
function webpContainer(chunks) {
  const payload = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF");
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}
const vp8x = () =>
  webpChunk("VP8X", Buffer.from("02000000010000010000", "hex"));
const anim = () => webpChunk("ANIM", Buffer.alloc(6));
const frameHeader = () =>
  Buffer.from("00000000000000000000000064000000", "hex");
test("animated WebP validates real multi-frame bytes and rejects empty, truncated or headerless frames", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animated-validate-")),
    file = path.join(dir, "image");
  const valid = fs.readFileSync(
    path.join(__dirname, "fixtures/project-animated.webp"),
  );
  try {
    fs.writeFileSync(file, valid);
    assert.equal(
      (
        await validateProjectImage(file, {
          ext: "webp",
          expectedSize: valid.length,
        })
      ).size,
      valid.length,
    );
    const bad = [
      Buffer.from(
        "524946462400000057454250414e4d4618000000000000000000000000000000000000000000000000000000",
        "hex",
      ),
      webpContainer([
        vp8x(),
        anim(),
        webpChunk("ANMF", Buffer.concat([frameHeader(), Buffer.alloc(8)])),
      ]),
      webpContainer([
        vp8x(),
        anim(),
        webpChunk(
          "ANMF",
          Buffer.concat([
            frameHeader(),
            Buffer.from("56503820160000003001", "hex"),
          ]),
        ),
      ]),
      webpContainer([
        webpChunk(
          "ANMF",
          Buffer.concat([frameHeader(), samples.webp.subarray(12)]),
        ),
      ]),
      webpContainer([
        vp8x(),
        webpChunk(
          "ANMF",
          Buffer.concat([frameHeader(), samples.webp.subarray(12)]),
        ),
      ]),
    ];
    for (const bytes of bad) {
      fs.writeFileSync(file, bytes);
      await assert.rejects(
        validateProjectImage(file, { ext: "webp", expectedSize: bytes.length }),
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("WebP unknown chunk traversal validates a modest file within a capped child heap", () => {
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webp-memory-")),
    file = path.join(dir, "image.webp");
  // 131072 legal empty unknown chunks in only1MiB: retaining a descriptor per
  // chunk exceeds this child's small heap, while streaming descriptors does not.
  const unknown = Buffer.alloc(1024 * 1024);
  for (let p = 0; p < unknown.length; p += 8) unknown.write("JUNK", p);
  const bytes = webpContainer([samples.webp.subarray(12), unknown]);
  fs.writeFileSync(file, bytes);
  try {
    const script = `const fs=require('node:fs');const {validateProjectImage}=require(process.argv[1]);validateProjectImage(process.argv[2],{ext:'webp',expectedSize:fs.statSync(process.argv[2]).size}).then(result=>process.stdout.write(String(result.size))).catch(error=>{process.stderr.write(error.message);process.exitCode=1;});`;
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=12",
        "-e",
        script,
        path.join(__dirname, "../server/project-image-delivery"),
        file,
      ],
      { cwd: dir, encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 },
    );
    assert.equal(
      child.status,
      0,
      `bounded child failed: signal=${child.signal}, ${child.stderr?.slice(0, 150)}`,
    );
    assert.equal(child.stdout, String(bytes.length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for(const [ext,hex] of [['jpg','ffd8ffc00008080001000101ffda0002ffd9'],['gif','47494638396101000100800000000000ffffff2c00000000010001000002003b']])test(`rejects empty malformed ${ext} encoded payload`,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'empty-raster-')),file=path.join(dir,'image');const bytes=Buffer.from(hex,'hex');
 try {fs.writeFileSync(file,bytes);await assert.rejects(validateProjectImage(file,{ext,expectedSize:bytes.length}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
for(const [name,ext] of [['project-baseline.jpg','jpg'],['project-progressive.jpg','jpg'],['project-animated.gif','gif']])test(`preserves real encoded ${name}`,async()=>{
 const file=path.join(__dirname,'fixtures',name), bytes=fs.readFileSync(file);
 assert.equal((await validateProjectImage(file,{ext,expectedSize:bytes.length})).fingerprint,crypto.createHash('sha256').update(bytes).digest('hex'));
});
test('GIF image requires a global or local color table',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gif-table-')),file=path.join(dir,'image');
 const bytes=Buffer.from('474946383961010001000000002c00000000010001000002014c003b','hex');
 try{fs.writeFileSync(file,bytes);await assert.rejects(validateProjectImage(file,{ext:'gif',expectedSize:bytes.length}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
