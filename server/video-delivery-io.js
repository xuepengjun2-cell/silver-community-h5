const fs = require("fs");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

function byteLimit(maxBytes, onBytes) {
  let size = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (onBytes) { try { onBytes(size); } catch {} }
      callback(size > maxBytes ? new Error("原视频超过上传大小限制。") : null, chunk);
    }
  });
  return { stream, size: () => size };
}

async function ensureWorkingSpace(directory, requiredBytes) {
  const stats = await fs.promises.statfs(directory);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < requiredBytes) {
    throw new Error("视频处理空间不足，原片已保留；请稍后重试。 ");
  }
}

async function receiveRawVideo(req, destination, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw new Error("原视频超过上传大小限制。 ");
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const limit = byteLimit(maxBytes);
  await pipeline(req, limit.stream, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  const size = limit.size();
  if (!size || declared && size !== declared) throw new Error("视频上传不完整，请重试。 ");
  return size;
}

async function downloadVideo(url, destination, expectedBytes, maxBytes, options = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxBytes) {
    throw new Error("原视频大小不符合要求。 ");
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 60 * 60 * 1000);
  timer.unref?.();
  options.signal?.addEventListener('abort', abort, {once:true});
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`原视频读取失败（HTTP ${response.status}）。`);
    const limit = byteLimit(maxBytes, bytes => options.onProgress?.({phase:'downloading',percent:Math.min(99,bytes/expectedBytes*100)}));
    await pipeline(Readable.fromWeb(response.body), limit.stream, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }), {signal:controller.signal});
    if (limit.size() !== expectedBytes) throw new Error("原视频下载不完整，暂不发布。 ");
    return limit.size();
  } catch (error) {
    if (options.signal?.aborted) throw Object.assign(new Error('任务已停止，原片保留'),{name:'AbortError',code:'VIDEO_TASK_ABORTED'});
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = { ensureWorkingSpace, receiveRawVideo, downloadVideo };
