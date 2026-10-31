"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { withServer, sleep } = require("./support/video-api-server");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const route = (id) => `/my/activity-projects/${id}`;
async function setup(ctx) {
  const token = await ctx.login();
  const r = await ctx.api("/my/activity-projects", {
    method: "POST",
    token,
    body: { title: "照片测试" },
  });
  return { token, album: r.data.project.id };
}
const init = (ctx, token, album, body = {}) =>
  ctx.api(`${route(album)}/media/init`, {
    method: "POST",
    token,
    body: {
      type: "image",
      ext: "png",
      title: "photo.png",
      size: PNG.length,
      ...body,
    },
  });
const row = (ctx, id) =>
  ctx.persisted().project_upload_sessions.find((r) => r.id === id);
const object = (ctx, key) => path.join(ctx.dir, "tos", encodeURIComponent(key));
async function finish(ctx, token, album, id) {
  const r = await ctx.api(
    `${route(album)}/media/upload-session/${id}/complete?delivery=1`,
    {
      method: "POST",
      token,
      body: {},
    },
  );
  assert.ok([200, 202].includes(r.status), JSON.stringify(r));
  for (let i = 0; i < 120; i++) {
    const s = await ctx.api(
      `${route(album)}/media/upload-session/${id}/status`,
      { token },
    );
    if (["completed", "delivery_failed"].includes(s.data.status)) return s;
    await sleep(30);
  }
  assert.fail(ctx.logs());
}
test("photo init enforces raster format and 50MiB bound; retries share one durable session", () =>
  withServer({}, async (ctx) => {
    const { token, album } = await setup(ctx);
    assert.equal((await init(ctx, token, album, { ext: "svg" })).status, 400);
    assert.equal(
      (await init(ctx, token, album, { size: 52428801 })).status,
      413,
    );
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        init(ctx, token, album, { clientUploadId: "a".repeat(32) }),
      ),
    );
    for (const r of replies)
      assert.ok([200, 201].includes(r.status), JSON.stringify(r));
    assert.equal(new Set(replies.map((r) => r.data.sessionId)).size, 1);
    assert.equal(ctx.persisted().project_upload_sessions.length, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ctx.dir, "tos.initiations.json")))
        .length,
      1,
    );
    assert.equal(replies[0].data.partSize, 8388608);
    for (const delta of [
      { size: 70 },
      { type: "video", ext: "mp4" },
      { title: "changed.png" },
    ])
      assert.equal(
        (
          await init(ctx, token, album, {
            clientUploadId: "a".repeat(32),
            ...delta,
          })
        ).status,
        409,
      );
    assert.equal(
      (await init(ctx, token, album, { clientUploadId: "bad" })).status,
      400,
    );
  }));
test("photo publishes unchanged bytes, server hash, completed receipt, duplicate lookup, and refuses deleted receipt", () =>
  withServer({}, async (ctx) => {
    const { token, album } = await setup(ctx);
    const r = await init(ctx, token, album, { clientUploadId: "b".repeat(32) });
    assert.equal(r.status, 201);
    const source = row(ctx, r.data.sessionId);
    fs.writeFileSync(object(ctx, source.object_key), PNG);
    const done = await finish(ctx, token, album, source.id);
    assert.equal(done.data.status, "completed", ctx.logs());
    const albumData = (await ctx.api(route(album), { token })).data.project;
    assert.equal(albumData.media.length, 1);
    const media = albumData.media[0];
    assert.equal(
      media.fingerprint,
      crypto.createHash("sha256").update(PNG).digest("hex"),
    );
    assert.deepEqual(
      fs.readFileSync(
        object(ctx, decodeURIComponent(new URL(media.url).pathname.slice(1))),
      ),
      PNG,
    );
    assert.equal(fs.existsSync(object(ctx, source.object_key)), false);
    assert.equal(
      (await finish(ctx, token, album, source.id)).data.status,
      "completed",
    );
    const duplicate = await init(ctx, token, album, {
      clientUploadId: "c".repeat(32),
      fingerprint: media.fingerprint,
    });
    assert.equal(duplicate.data.status, "completed");
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(ctx.persisted().project_upload_sessions.length, 2);
    const removed = await ctx.api(`${route(album)}/media/0`, {
      method: "DELETE",
      token,
    });
    assert.equal(removed.status, 200);
    assert.equal(
      (
        await ctx.api(
          `${route(album)}/media/upload-session/${source.id}/status`,
          { token },
        )
      ).status,
      409,
    );
    assert.equal(
      (await init(ctx, token, album, { clientUploadId: "b".repeat(32) }))
        .status,
      409,
    );
    assert.equal(
      (
        await ctx.api(
          `${route(album)}/media/upload-session/${source.id}/resume`,
          { method: "POST", token, body: {} },
        )
      ).status,
      409,
    );
  }));
module.exports = { PNG };

test("photo stays invisible until SQL commit; account writes serialize with final publication", () =>
  withServer({}, async (ctx) => {
    const admin = await ctx.login();
    const made = await ctx.api("/admin/users", {
      method: "POST",
      token: admin,
      body: {
        username: "photo-owner",
        name: "Photo owner",
        role: "operator",
        password: "photo-password",
      },
    });
    assert.equal(made.status, 201);
    const userId = made.data.user.id;
    const token = (
      await ctx.api("/login", {
        method: "POST",
        body: { username: "photo-owner", password: "photo-password" },
      })
    ).data.token;
    const album = (
      await ctx.api("/my/activity-projects", {
        method: "POST",
        token,
        body: { title: "Photo permission" },
      })
    ).data.project.id;
    const r = await init(ctx, token, album);
    assert.equal(r.status, 201);
    const source = row(ctx, r.data.sessionId);
    fs.writeFileSync(object(ctx, source.object_key), PNG);
    // The fixture gates the actual SQL persistence boundary rather than replacing the publisher.
    const entered = path.join(ctx.dir, "sql.entered"),
      release = path.join(ctx.dir, "sql.release");
    fs.writeFileSync(
      path.join(ctx.dir, "db-gate.json"),
      JSON.stringify({
        id: "photo-commit",
        sqlIncludes: "INSERT INTO activity_projects",
        paramsInclude: [album],
        enteredFile: entered,
        releaseFile: release,
      }),
    );
    await ctx.api(
      `${route(album)}/media/upload-session/${source.id}/complete?delivery=1`,
      {
        method: "POST",
        token,
        body: {},
      },
    );
    for (let i = 0; i < 100 && !fs.existsSync(entered); i++) await sleep(20);
    assert.ok(fs.existsSync(entered), "SQL gate entered");
    assert.equal(
      (await ctx.api(route(album), { token: admin })).data.project.media.length,
      0,
      "uncommitted image must not be visible",
    );
    const demoting = ctx.api(`/admin/users/${userId}`, {
      method: "PUT",
      token: admin,
      body: { role: "viewer", status: "active" },
    });
    await sleep(100);
    fs.writeFileSync(release, "release");
    await demoting;
    for (
      let i = 0;
      i < 100 &&
      !["completed", "delivery_failed"].includes(row(ctx, source.id).status);
      i++
    )
      await sleep(20);
    assert.equal(row(ctx, source.id).status, "completed", ctx.logs());
    const p = (await ctx.api(route(album), { token: admin })).data.project;
    assert.equal(p.media.length, 1);
  }));

test("client seeded image metadata cannot prove a trusted duplicate at init or commit", () =>
  withServer({}, async (ctx) => {
    const token = await ctx.login(),
      fingerprint = crypto.createHash("sha256").update(PNG).digest("hex"),
      url = "https://proj2.likeduoduiyi.cn/silver-project-images/untrusted.png";
    fs.mkdirSync(path.join(ctx.dir, "tos"), { recursive: true });
    fs.writeFileSync(object(ctx, "silver-project-images/untrusted.png"), PNG);
    const made = await ctx.api("/my/activity-projects", {
      method: "POST",
      token,
      body: {
        title: "Untrusted metadata",
        media: [{ type: "image", url, size: PNG.length, fingerprint }],
      },
    });
    const album = made.data.project.id;
    const r = await init(ctx, token, album, { fingerprint });
    assert.equal(r.data.status, "uploading");
    const source = row(ctx, r.data.sessionId);
    fs.writeFileSync(object(ctx, source.object_key), PNG);
    assert.equal(
      (await finish(ctx, token, album, source.id)).data.status,
      "completed",
    );
    assert.notEqual(row(ctx, source.id).media_url, url);
  }));

async function untilStatus(ctx, token, album, id, predicate) {
  for (let i = 0; i < 120; i++) {
    const r = await ctx.api(
      `${route(album)}/media/upload-session/${id}/status`,
      { token },
    );
    if (predicate(r.data)) return r.data;
    await sleep(25);
  }
  assert.fail(ctx.logs());
}
for (const failure of ["copy", "database"])
  test(`failed ${failure} preserves original and never exposes photo`, () =>
    withServer(
      { env: failure === "copy" ? { FAKE_TOS_REJECT_COPY: "1" } : {} },
      async (ctx) => {
        const { token, album } = await setup(ctx),
          r = await init(ctx, token, album),
          source = row(ctx, r.data.sessionId);
        fs.writeFileSync(object(ctx, source.object_key), PNG);
        if (failure === "database")
          fs.writeFileSync(path.join(ctx.dir, "reject-photo-db"), "fail");
        const done = await finish(ctx, token, album, source.id);
        assert.equal(done.data.status, "delivery_failed", JSON.stringify(done));
        assert.ok(fs.existsSync(object(ctx, source.object_key)));
        assert.equal(
          (await ctx.api(route(album), { token })).data.project.media.length,
          0,
        );
      },
    ));
test("photo pause and immediate resume cannot let old copy overwrite resumed execution", () =>
  withServer({ tosDelay: 300 }, async (ctx) => {
    const { token, album } = await setup(ctx),
      r = await init(ctx, token, album),
      source = row(ctx, r.data.sessionId);
    fs.writeFileSync(object(ctx, source.object_key), PNG);
    const base = `${route(album)}/media/upload-session/${source.id}`;
    await ctx.api(`${base}/resume`, { method: "POST", token, body: {} });
    await untilStatus(
      ctx,
      token,
      album,
      source.id,
      (s) => s.progress?.stage === "uploading",
    );
    assert.equal(
      (await ctx.api(`${base}/pause`, { method: "POST", token, body: {} })).data
        .status,
      "paused",
    );
    const resumed = await ctx.api(`${base}/resume`, {
      method: "POST",
      token,
      body: {},
    });
    assert.equal(resumed.status, 202);
    const done = await untilStatus(ctx, token, album, source.id, (s) =>
      ["completed", "delivery_failed"].includes(s.status),
    );
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(
      (await ctx.api(route(album), { token })).data.project.media.length,
      1,
    );
  }));
test("photo partial pause/resume preserves numbered parts and actual bytes", () =>
  withServer({}, async (ctx) => {
    const { token, album } = await setup(ctx),
      r = await init(ctx, token, album, { size: 9 * 1024 * 1024 }),
      source = row(ctx, r.data.sessionId),
      base = `${route(album)}/media/upload-session/${source.id}`;
    fs.writeFileSync(
      `${object(ctx, source.object_key)}.parts.json`,
      JSON.stringify([{ PartNumber: 1, Size: 8388608, ETag: "retained" }]),
    );
    await ctx.api(`${base}/pause`, { method: "POST", token, body: {} });
    const resumed = await ctx.api(`${base}/resume`, {
      method: "POST",
      token,
      body: {},
    });
    assert.equal(resumed.data.status, "uploading");
    assert.equal(resumed.data.uploadedBytes, 8388608);
    assert.deepEqual(resumed.data.completedParts, [1]);
  }));
test("a photo finishes independently while a delayed video is processing", () =>
  withServer({ tosDelay: 700 }, async (ctx) => {
    const { token, album } = await setup(ctx),
      v = await init(ctx, token, album, { type: "video", ext: "mp4" }),
      video = row(ctx, v.data.sessionId);
    fs.writeFileSync(object(ctx, video.object_key), PNG);
    await ctx.api(`${route(album)}/media/upload-session/${video.id}/resume`, {
      method: "POST",
      token,
      body: {},
    });
    await untilStatus(
      ctx,
      token,
      album,
      video.id,
      (s) => s.status === "processing",
    );
    const p = await init(ctx, token, album),
      photo = row(ctx, p.data.sessionId);
    fs.writeFileSync(object(ctx, photo.object_key), PNG);
    assert.equal(
      (await finish(ctx, token, album, photo.id)).data.status,
      "completed",
    );
    assert.equal(
      row(ctx, video.id).status,
      "processing",
      "photo must not wait behind video output/poster work",
    );
  }));
test("photo revocation during delayed copy fails closed and keeps source", () =>
  withServer({ tosDelay: 500 }, async (ctx) => {
    const admin = await ctx.login(),
      made = await ctx.api("/admin/users", {
        method: "POST",
        token: admin,
        body: {
          username: "revoked-photo",
          name: "owner",
          role: "operator",
          password: "photo-password",
        },
      });
    const token = (
      await ctx.api("/login", {
        method: "POST",
        body: { username: "revoked-photo", password: "photo-password" },
      })
    ).data.token;
    const album = (
      await ctx.api("/my/activity-projects", {
        method: "POST",
        token,
        body: { title: "Revoked" },
      })
    ).data.project.id;
    const r = await init(ctx, token, album),
      source = row(ctx, r.data.sessionId);
    fs.writeFileSync(object(ctx, source.object_key), PNG);
    await ctx.api(`${route(album)}/media/upload-session/${source.id}/resume`, {
      method: "POST",
      token,
      body: {},
    });
    await untilStatus(
      ctx,
      token,
      album,
      source.id,
      (s) => s.progress?.stage === "uploading",
    );
    await ctx.api(`/admin/users/${made.data.user.id}`, {
      method: "PUT",
      token: admin,
      body: { role: "viewer" },
    });
    await untilStatus(
      ctx,
      admin,
      album,
      source.id,
      (s) => s.status === "delivery_failed",
    );
    assert.equal(
      (await ctx.api(route(album), { token: admin })).data.project.media.length,
      0,
    );
    assert.ok(fs.existsSync(object(ctx, source.object_key)));
  }));

test("headquarters cannot obtain new PUT signatures after uploader loses album management", () =>
  withServer({}, async (ctx) => {
    const admin = await ctx.login(),
      made = await ctx.api("/admin/users", {
        method: "POST",
        token: admin,
        body: {
          username: "signature-photo",
          name: "owner",
          role: "operator",
          password: "photo-password",
        },
      }),
      token = (
        await ctx.api("/login", {
          method: "POST",
          body: { username: "signature-photo", password: "photo-password" },
        })
      ).data.token;
    const album = (
        await ctx.api("/my/activity-projects", {
          method: "POST",
          token,
          body: { title: "Signature" },
        })
      ).data.project.id,
      r = await init(ctx, token, album);
    await ctx.api(`/admin/users/${made.data.user.id}`, {
      method: "PUT",
      token: admin,
      body: { role: "viewer" },
    });
    assert.equal(
      (
        await ctx.api(
          `${route(album)}/media/upload-session/${r.data.sessionId}/part-url?partNumber=1`,
          {
            token: admin,
          },
        )
      ).status,
      403,
    );
  }));
test("same initialization identifier stays scoped to album and account; old video init remains compatible", () =>
  withServer({}, async (ctx) => {
    const { token, album } = await setup(ctx),
      other = await setup(ctx),
      a = await init(ctx, token, album, { clientUploadId: "e".repeat(32) }),
      b = await init(ctx, token, other.album, {
        clientUploadId: "e".repeat(32),
      });
    assert.notEqual(a.data.sessionId, b.data.sessionId);
    const made = await ctx.api("/admin/users", {
      method: "POST",
      token,
      body: {
        username: "second-admin",
        name: "admin",
        role: "admin",
        password: "photo-password",
      },
    });
    assert.equal(made.status, 201);
    const second = (
        await ctx.api("/login", {
          method: "POST",
          body: { username: "second-admin", password: "photo-password" },
        })
      ).data.token,
      c = await init(ctx, second, album, { clientUploadId: "e".repeat(32) });
    assert.notEqual(a.data.sessionId, c.data.sessionId);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await init(ctx, token, album, { type: "video", ext: "mp4" })).status,
        201,
      );
    assert.equal(ctx.persisted().project_upload_sessions.length, 5);
  }));
test("complete verifies actual numbered multipart bytes before publishing", () =>
  withServer({}, async (ctx) => {
    const { token, album } = await setup(ctx),
      r = await init(ctx, token, album),
      source = row(ctx, r.data.sessionId);
    fs.writeFileSync(
      `${object(ctx, source.object_key)}.parts.json`,
      JSON.stringify([{ PartNumber: 1, Size: PNG.length, ETag: "actual" }]),
    );
    fs.writeFileSync(`${object(ctx, source.object_key)}.part-1`, PNG);
    assert.equal(
      (await finish(ctx, token, album, source.id)).data.status,
      "completed",
    );
  }));
test("changed source ETag before native copy fails closed with original retained", () =>
  withServer({ env: { FAKE_TOS_MUTATE_COPY: "1" } }, async (ctx) => {
    const { token, album } = await setup(ctx),
      r = await init(ctx, token, album),
      source = row(ctx, r.data.sessionId);
    fs.writeFileSync(object(ctx, source.object_key), PNG);
    const done = await finish(ctx, token, album, source.id);
    assert.equal(done.data.status, "delivery_failed");
    assert.equal(
      (await ctx.api(route(album), { token })).data.project.media.length,
      0,
    );
    assert.ok(fs.existsSync(object(ctx, source.object_key)));
  }));

for (const initialStatus of ["queued", "uploading"])
  test(`restart recovers ${initialStatus} photo with complete source without browser`, () => {
    const ts = new Date().toISOString(),
      album = "project_photo_restart",
      id = "project_upload_photo_restart",
      key = "silver-project-image-sources/restart.png",
      salt = "restart-photo",
      admin = {
        id: "u_admin",
        username: "admin",
        name: "Admin",
        role: "admin",
        status: "active",
        salt,
        passwordHash: crypto
          .createHash("sha256")
          .update(`${salt}:admin123`)
          .digest("hex"),
      };
    const doc = {
      id: album,
      title: "Restart photo",
      ownerId: admin.id,
      status: "published",
      shareEnabled: true,
      media: [],
    };
    const seed = {
      users: [
        {
          id: admin.id,
          username: admin.username,
          role: admin.role,
          doc: JSON.stringify(admin),
        },
      ],
      activity_projects: [
        {
          id: album,
          owner_id: admin.id,
          status: "published",
          created_at: ts,
          updated_at: ts,
          doc: JSON.stringify(doc),
        },
      ],
      project_upload_sessions: [
        {
          id,
          project_id: album,
          owner_id: admin.id,
          type: "image",
          ext: ".png",
          title: "restart.png",
          filename: "restart.png",
          object_key: key,
          upload_id: "fake-upload",
          file_size: PNG.length,
          part_size: 8388608,
          part_count: 1,
          status: initialStatus,
          created_at: ts,
          updated_at: ts,
        },
      ],
    };
    return withServer(
      {
        seed,
        beforeStart({ dir }) {
          fs.mkdirSync(path.join(dir, "tos"), { recursive: true });
          fs.writeFileSync(object({ dir }, key), PNG);
        },
      },
      async (ctx) => {
        const token = await ctx.login();
        const done = await untilStatus(ctx, token, album, id, (s) =>
          ["completed", "delivery_failed"].includes(s.status),
        );
        assert.equal(done.status, "completed", JSON.stringify(done));
        assert.equal(
          (await ctx.api(route(album), { token })).data.project.media[0].type,
          "image",
        );
      },
    );
  });

test("concurrent complete requests and identical photo sessions persist one canonical image", () =>
  withServer({}, async (ctx) => {
    const { token, album } = await setup(ctx),
      a = await init(ctx, token, album, { clientUploadId: "1".repeat(32) }),
      b = await init(ctx, token, album, { clientUploadId: "2".repeat(32) });
    for (const r of [a, b])
      fs.writeFileSync(object(ctx, row(ctx, r.data.sessionId).object_key), PNG);
    const responses = await Promise.all(
      [a, a, b].map((r) =>
        ctx.api(
          `${route(album)}/media/upload-session/${r.data.sessionId}/complete?delivery=1`,
          { method: "POST", token, body: {} },
        ),
      ),
    );
    assert.ok(responses.every((r) => [200, 202].includes(r.status)));
    for (const r of [a, b])
      assert.equal(
        (
          await untilStatus(ctx, token, album, r.data.sessionId, (s) =>
            ["completed", "delivery_failed"].includes(s.status),
          )
        ).status,
        "completed",
      );
    assert.equal(
      (await ctx.api(route(album), { token })).data.project.media.length,
      1,
    );
    assert.equal(
      row(ctx, a.data.sessionId).media_url,
      row(ctx, b.data.sessionId).media_url,
    );
  }));
