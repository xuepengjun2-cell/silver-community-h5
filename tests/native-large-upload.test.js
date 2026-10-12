// Regression for the existing backend multipart protocol with real HTTP/FFmpeg
// and isolated fake MySQL/TOS. The personal miniapp no longer provides video
// upload; this test protects retained server processing and customer files.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { withServer, sleep } = require("./support/video-api-server");
const { verifyVideoDelivery, MAX_VIDEO_BYTES: MAX_VIDEO } = require("../server/miniapp-media");

async function makeVideo(file, bitrate, input) {
  await exec("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
    ...(input ? ["-i", input] : ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=36", "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=44100:duration=36"]),
    "-map", "0:v:0", "-map", input ? "0:a:0" : "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p",
    "-b:v", `${bitrate}k`, "-minrate", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate}k`,
    "-x264-params", "nal-hrd=cbr:filler=1", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-y", file
  ], { timeout: 60000 });
}
async function fileHash(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function multipart(ctx, { id, token, file, extraBytes = 0, abortAfter = 0, progress = () => {} }) {
  const boundary = "native-large-video-test", length = fs.statSync(file).size;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: ctx.port,
      path: `/api/my/activity-projects/${id}/miniapp-media?type=video`, method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": head.length + length + extraBytes + tail.length }
    }, response => {
      const parts = []; response.on("data", c => parts.push(c));
      response.on("end", () => {
        try { resolve({ statusCode: response.statusCode, data: Buffer.concat(parts).toString() }); }
        catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    (async () => {
      request.write(head);
      let sent = 0;
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
        sent += chunk.length;
        if (!request.write(chunk)) await once(request, "drain");
        progress(Math.min(100, Math.floor(sent * 100 / (length + extraBytes))));
        if (abortAfter && sent >= abortAfter) { request.destroy(new Error("test: client aborted upload")); return; }
      }
      // A legal MP4 free box supplies exact boundary bytes without a giant
      // allocation; the receiver must reject by actual received size.
      if (extraBytes) {
        const box = Buffer.alloc(8); box.writeUInt32BE(extraBytes); box.write("free", 4); request.write(box);
        let remaining = extraBytes - 8;
        const zeros = Buffer.alloc(256 * 1024);
        while (remaining > 0) { const chunk = zeros.subarray(0, Math.min(zeros.length, remaining)); if (!request.write(chunk)) await once(request, "drain"); remaining -= chunk.length; }
      }
      request.end(tail);
    })().catch(error => { request.destroy(); reject(error); });
  });
}

test("retained backend large-file transfer and delivery gate", { timeout: 180000 }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "silver-native-large-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const original = path.join(root, "original.mp4"), compressed = path.join(root, "compressed.mp4");
  await makeVideo(original, 55000); await makeVideo(compressed, 43700, original);
  const originalBytes = fs.statSync(original).size, compressedBytes = fs.statSync(compressed).size;
  assert.ok(originalBytes > 200000000, `expected >200MB source, got ${originalBytes}`);
  assert.ok(compressedBytes > 180 * 1024 * 1024 && compressedBytes < MAX_VIDEO, `expected near-limit client output, got ${compressedBytes}`);
  await verifyVideoDelivery(original, compressed);
  const report = { originalBytes, compressedBytes, originalSha256: await fileHash(original), checks: [] };
  await withServer({ env: { REAL_MEDIA_PROCESSING: "1" }, tosDelay: 100 }, async ctx => {
    const token = await ctx.login();
    const created = await ctx.api("/my/activity-projects", { method: "POST", token, body: { title: "isolated native large test", status: "published", shareEnabled: true } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.project.id, route = `/my/activity-projects/${id}`;
    const project = async () => (await ctx.api(route, { token })).data.project;
    const waitJob = async (jobId, final) => {
      let job;
      for (let i = 0; i < 600; i++) {
        job = (await ctx.api(`${route}/miniapp-media/${jobId}`, { token })).data;
        if (final.includes(job.status)) return job;
        await sleep(100);
      }
      throw Error(`job did not finish: ${JSON.stringify(job)}; ${ctx.logs().slice(-2000)}`);
    };
    await t.test("near-190MiB multipart transfers completely and stays private until ready", async () => {
      const progress = [];
      const response = await multipart(ctx, { id, token, file: compressed, progress: percent => progress.push(percent) });
      assert.equal(response.statusCode, 202, response.data);
      const uploaded = JSON.parse(response.data);
      assert.ok(uploaded.jobId); assert.ok(progress.includes(100));
      assert.equal((await project()).media.length, 0, "100% transport must not publish unprocessed video");
      const job = await waitJob(uploaded.jobId, ["ready", "failed"]);
      assert.equal(job.status, "ready", job.error);
      const media = (await project()).media;
      assert.equal(media.length, 1); assert.equal(media[0].type, "video");
      assert.ok(media[0].size > 0 && media[0].size < MAX_VIDEO); assert.ok(media[0].poster);
      const tosFile = url => path.join(ctx.dir, "tos", encodeURIComponent(new URL(url).pathname.slice(1)));
      const final = tosFile(media[0].url), poster = tosFile(media[0].poster);
      const validation = await verifyVideoDelivery(compressed, final);
      assert.equal(await fileHash(final), media[0].fingerprint);
      assert.ok((await fsp.readFile(poster)).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
      const stagedSource = path.join(ctx.dir, "data/.miniapp-upload-staging", uploaded.jobId, "source");
      for (let i = 0; i < 30 && fs.existsSync(stagedSource); i++) await sleep(100);
      assert.equal(fs.existsSync(stagedSource), false);
      report.checks.push({ check: "real-upload-and-processing", passed: true, finalBytes: validation.size, duration: validation.duration, videoDuration: validation.videoDuration, audioDuration: validation.audioDuration, posterBytes: fs.statSync(poster).size });
    });
    await t.test("server independently rejects an exact-190MiB multipart file without adding media", async () => {
      const response = await multipart(ctx, { id, token, file: compressed, extraBytes: MAX_VIDEO - compressedBytes });
      assert.equal(response.statusCode, 413, response.data); assert.match(JSON.parse(response.data).error, /过大|大小|200MB/);
      assert.equal((await project()).media.length, 1);
      report.checks.push({ check: "server-size-boundary", bytes: MAX_VIDEO, status: response.statusCode, passed: true });
    });
    await t.test("client abort removes partial source and does not publish or occupy receiving slot", async () => {
      await assert.rejects(multipart(ctx, { id, token, file: compressed, abortAfter: 2 * 1024 * 1024 }), /aborted|reset|socket/i);
      await sleep(250);
      const staging = path.join(ctx.dir, "data/.miniapp-upload-staging");
      const partials = fs.existsSync(staging) ? fs.readdirSync(staging).filter(n => fs.existsSync(path.join(staging, n, "source"))) : [];
      assert.deepEqual(partials, []);
      const jobs = JSON.parse(fs.readFileSync(path.join(ctx.dir, "data/miniapp-video-jobs.json")));
      assert.equal(jobs.some(j => j.status === "receiving"), false);
      assert.equal((await project()).media.length, 1);
      report.checks.push({ check: "client-abort-cleanup", passed: true });
    });
    await t.test("invalid video fails real FFmpeg; source is retryable and never enters shared album", async () => {
      const broken = path.join(root, "broken.mp4"); await fsp.writeFile(broken, crypto.randomBytes(4000));
      const response = await multipart(ctx, { id, token, file: broken });
      assert.equal(response.statusCode, 202); const jobId = JSON.parse(response.data).jobId;
      const failed = await waitJob(jobId, ["failed", "ready"]); assert.equal(failed.status, "failed"); assert.equal(failed.url, undefined);
      assert.equal((await project()).media.length, 1);
      assert.ok(fs.existsSync(path.join(ctx.dir, "data/.miniapp-upload-staging", jobId, "source")));
      assert.equal((await ctx.api(`${route}/miniapp-media/${jobId}/retry`, { method: "POST", token, body: {} })).status, 202);
      assert.equal((await waitJob(jobId, ["failed", "ready"])).status, "failed");
      assert.equal((await project()).media.length, 1);
      report.checks.push({ check: "invalid-file-retry", passed: true });
    });
  });
  assert.equal(await fileHash(original), report.originalSha256, "test must not overwrite original");
  assert.equal(report.checks.length, 4, "all four large-file checks must pass before writing a success report");
  if (process.env.SILVER_NATIVE_TEST_REPORT) await fsp.writeFile(process.env.SILVER_NATIVE_TEST_REPORT, JSON.stringify({ ...report, passed: true, deviceWeChatApisTested: false }, null, 2) + "\n");
  console.log(JSON.stringify({ originalBytes, compressedBytes, passed: true, checks: report.checks }));
});
