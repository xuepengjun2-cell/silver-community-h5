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

// Synthetic MPF container made solely from repository-owned, nonpersonal JPEGs.
function mpfFixture(little = true, gapSize = 291) {
  const primary = fs.readFileSync(path.join(__dirname, 'fixtures/project-baseline.jpg'));
  const secondary = fs.readFileSync(path.join(__dirname, 'fixtures/project-progressive.jpg'));
  const tiff = Buffer.alloc(82);
  const u16 = (v, p) => little ? tiff.writeUInt16LE(v, p) : tiff.writeUInt16BE(v, p);
  const u32 = (v, p) => little ? tiff.writeUInt32LE(v, p) : tiff.writeUInt32BE(v, p);
  tiff.write(little ? 'II' : 'MM');u16(42, 2);u32(8, 4);u16(3, 8);
  u16(0xb000, 10);u16(7, 12);u32(4, 14);tiff.write('0100', 18);
  u16(0xb001, 22);u16(4, 24);u32(1, 26);u32(2, 30);
  u16(0xb002, 34);u16(7, 36);u32(32, 38);u32(50, 42);
  const segment = Buffer.alloc(90);segment.set([255, 226, 0, 88]);segment.write('MPF\0', 4);
  const primaryEnd = primary.length + segment.length, secondaryStart = primaryEnd + gapSize;
  u32(0x20030000, 50);u32(primaryEnd, 54);u32(0, 58);
  u32(0, 66);u32(secondary.length, 70);u32(secondaryStart - 10, 74);
  tiff.copy(segment, 8);
  const bytes = Buffer.concat([primary.subarray(0, 2), segment, primary.subarray(2), Buffer.alloc(gapSize, 0x5a), secondary]);
  const set16=(b,v,p)=>little?b.writeUInt16LE(v,10+p):b.writeUInt16BE(v,10+p);
  const set32=(b,v,p)=>little?b.writeUInt32LE(v,10+p):b.writeUInt32BE(v,10+p);
  return {bytes, primaryEnd, secondaryStart, set16, set32};
}
for (const little of [true, false]) test(`MPF ${little?'little':'big'} endian preserves two indexed JPEGs and declared gap byte-for-byte`, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpf-valid-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'image.jpeg');
  for(const gap of [0,291]) {
    const {bytes}=mpfFixture(little,gap);fs.writeFileSync(file,bytes);
    const result=await validateProjectImage(file,{ext:'jpeg',expectedSize:bytes.length});
    assert.equal(result.size,bytes.length);assert.equal(result.contentType,'image/jpeg');assert.equal(result.fingerprint,crypto.createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(fs.readFileSync(file),bytes);
  }
});
test('MPF rejects malformed tables, ambiguous ranges, truncated pictures and unindexed tails', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpf-invalid-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'image.jpeg');
  for(const little of [true,false]){
    const f=mpfFixture(little);
    const cases=[
      ['primary offset',b=>f.set32(b,1,58)],['primary size',b=>f.set32(b,f.primaryEnd-1,54)],
      ['overlap',b=>f.set32(b,f.primaryEnd-11,74)],['out of bounds',b=>f.set32(b,0xffffffff,74)],
      ['secondary short',b=>f.set32(b,b.length-f.secondaryStart-1,70)],['secondary long',b=>f.set32(b,b.length,70)],
      ['truncated primary',b=>{b[f.primaryEnd-1]=0;}],['truncated secondary',b=>{b[b.length-1]=0;}],
      ['secondary missing SOI',b=>{b[f.secondaryStart]=0;}],
      ['secondary malformed SOS',b=>{const sos=b.indexOf(Buffer.from([255,218]),f.secondaryStart);assert.ok(sos>f.secondaryStart);b[sos+4]=0;}],
      ['table offset outside APP2',b=>f.set32(b,0xffffffff,42)],['table escapes APP2 into JPEG',b=>f.set32(b,80,42)],['table overlaps IFD',b=>f.set32(b,10,42)],
      ['table count mismatch',b=>f.set32(b,16,38)],['too many images',b=>f.set32(b,0xffffffff,30)],
      ['image work cap',b=>f.set32(b,33,30)],['zero images',b=>f.set32(b,0,30)],['wrong number type',b=>f.set16(b,3,24)],
      ['wrong table type',b=>f.set16(b,4,36)],['bad endian',b=>{b[10]=0;}],
      ['bad attribute IFD pointer',b=>f.set32(b,0xffffffff,46)],['attribute IFD overlaps index',b=>f.set32(b,8,46)],['bad TIFF signature',b=>f.set16(b,41,2)],['bad IFD offset',b=>f.set32(b,0xffffffff,4)],
      ['oversize IFD count',b=>f.set16(b,0xffff,8)],['duplicate number tag',b=>f.set16(b,0xb001,34)],
      ['non-JPEG MP entry',b=>f.set32(b,0x01000000,66)],['missing index version',b=>f.set16(b,0xb099,10)]
    ];
    for(const [name,mutate] of cases){const bytes=Buffer.from(f.bytes);mutate(bytes);fs.writeFileSync(file,bytes);await assert.rejects(validateProjectImage(file,{ext:'jpeg',expectedSize:bytes.length}),undefined,`${little?'LE':'BE'} ${name}`);}
    for(const bytes of [f.bytes.subarray(0,-1),Buffer.concat([f.bytes,Buffer.from('unindexed')]),Buffer.concat([samples.jpg,Buffer.from('arbitrary tail')]),Buffer.concat([samples.jpg,samples.jpg])]) {
      fs.writeFileSync(file,bytes);await assert.rejects(validateProjectImage(file,{ext:'jpeg',expectedSize:bytes.length}));
    }
  }
});
for(const little of [true,false])for(const [name,positions] of [['identifier',[6,7,8,9]],['endian',[10,11]],['version',[28,29,30,31]]])test(`MPF ${little?'LE':'BE'} rejects high-bit ${name} aliases`, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpf-signatures-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'image.jpeg');
  for(const position of positions){
    const {bytes}=mpfFixture(little);bytes[position]|=0x80;fs.writeFileSync(file,bytes);
    await assert.rejects(validateProjectImage(file,{ext:'jpeg',expectedSize:bytes.length}),undefined,`${little?'LE':'BE'} ${name} byte${position}`);
  }
});
