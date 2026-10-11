"use strict";

const MAX_DELIVERY_BYTES = 190 * 1024 * 1024;

function assertSourceHash(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual || "") || actual !== expected) throw new Error("原片 SHA-256 与上传声明不一致，暂不发布。");
}

function assertDeliveryMedia(media) {
  if (!media || media.type !== "video" || !Number.isSafeInteger(media.size) || media.size <= 0 || media.size >= MAX_DELIVERY_BYTES ||
      !/^[a-f0-9]{64}$/.test(media.fingerprint || "") || !/^[a-f0-9]{64}$/.test(media.sourceSha256 || "")) {
    throw new Error("视频成品大小或校验信息不符合要求，原片已保留。");
  }
  for (const [value, extension] of [[media.url, ".mp4"], [media.poster, ".jpg"]]) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("视频成品或首帧地址无效，原片已保留。"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith(extension)) {
      throw new Error("视频成品或首帧地址无效，原片已保留。");
    }
  }
  return media;
}

// All effects are supplied by the server. schedule must use its single shared
// FFmpeg queue; publish must re-read the latest case before mutating the cache.
function createCaseDirectDelivery(deps) {
  const locks = new Map();
  const queued = new Set();
  const reserved = new Set();
  const assertEnabled = () => {
    if (!deps.enabled()) throw Object.assign(new Error("后台视频处理已暂停；原片不会发布，请稍后重试。"), { httpStatus: 503 });
  };
  const withLock = (id, action) => {
    const previous = locks.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(action).finally(() => {
      if (locks.get(id) === task) locks.delete(id);
    });
    locks.set(id, task);
    return task;
  };
  const run = async id => {
    let prepared;
    let publicationAttempted = false;
    try {
      const session = await deps.readSession(id);
      if (!session || session.status !== "processing") return;
      assertEnabled();
      deps.assertCanPublish(session.case_id);
      // A crash may have persisted the media before recording completed. Only
      // reuse the exact server-created delivery for this session, never a source.
      let media = await deps.findPublished(session);
      if (!media) {
        prepared = await deps.prepare(session);
        media = prepared.media;
      }
      assertDeliveryMedia(media);
      await deps.validate(media);
      assertEnabled();
      deps.assertCanPublish(session.case_id);
      const current = await deps.readSession(id);
      if (!current || current.status !== "processing") throw new Error("上传任务状态已变化，原片暂不发布。");
      publicationAttempted = true;
      media = await deps.publish(session, media);
      if (!await deps.isPersisted(session, media)) throw new Error("视频尚未持久化，原片已保留。");
      await deps.updateSession(id, { status: "completed", media_url: media.url, error: null });
      await deps.deleteSource(session).catch(() => {});
    } catch (error) {
      // Cache may already reference the delivery even when persistence failed.
      // Keep all objects after attempting publication; never delete the source.
      if (prepared && !publicationAttempted) await deps.discard(prepared).catch(() => {});
      await deps.updateSession(id, { status: "delivery_failed", error: String(error.message || "视频处理失败").slice(0, 500) }).catch(() => {});
      if (deps.onError) deps.onError(id, error);
    } finally {
      if (deps.cleanup) await deps.cleanup(id).catch(() => {});
      queued.delete(id);
    }
  };
  const enqueue = id => {
    if (queued.has(id)) return;
    queued.add(id);
    deps.schedule(() => run(id));
  };
  const complete = (caseId, id) => withLock(`${caseId}:${id}`, async () => {
    try {
    assertEnabled();
    let session = await deps.readSession(id);
    if (!session || session.case_id !== caseId) throw Object.assign(new Error("上传会话不存在"), { httpStatus: 404 });
    deps.assertCanPublish(caseId);
    if (session.status === "aborted") throw Object.assign(new Error("上传会话已取消"), { httpStatus: 409 });
    if (session.status === "completed") {
      const media = await deps.findPublished(session);
      if (!media) throw Object.assign(new Error("视频登记与任务不一致，请联系管理员核对。"), { httpStatus: 409 });
      assertDeliveryMedia(media);
      await deps.validate(media);
      return { statusCode: 200, body: { ok: true, completed: true, status: "completed", sessionId: id, media, storage: "tos-multipart" } };
    }
    if (session.status !== "processing") {
      if (deps.assertCapacity) deps.assertCapacity();
      reserved.add(id);
      try { await deps.ensureSource(session); }
      catch (error) {
        await deps.updateSession(id, { status: "failed", error: String(error.message || "原片合并失败").slice(0, 500) }).catch(() => {});
        throw error;
      }
      assertEnabled();
      deps.assertCanPublish(caseId);
      session = await deps.readSession(id);
      if (!session || session.status === "aborted") throw Object.assign(new Error("上传会话已取消"), { httpStatus: 409 });
      await deps.updateSession(id, { status: "processing", error: null });
    }
    enqueue(id);
    return { statusCode: 202, body: { ok: true, completed: false, status: "processing", sessionId: id, storage: "tos-multipart" } };
    } finally { reserved.delete(id); }
  });
  const resume = async () => {
    for (const session of await deps.listProcessing()) {
      if (!deps.enabled()) await deps.updateSession(session.id, { status: "delivery_failed", error: "后台视频处理已暂停；原片已保留，可恢复后重试。" });
      else enqueue(session.id);
    }
  };
  return { complete, enqueue, resume, withLock, pendingCount: () => new Set([...queued, ...reserved]).size };
}

module.exports = { MAX_DELIVERY_BYTES, assertSourceHash, assertDeliveryMedia, createCaseDirectDelivery };
