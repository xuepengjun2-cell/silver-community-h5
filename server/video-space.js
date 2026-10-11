"use strict";

const fs = require("fs");

async function availableBytes(directory) {
  const stats = await fs.promises.statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

// One instance must be shared by receivers and workers. The caller creates the
// directory and holds its lease until that operation has finished writing.
function createVideoSpaceReservations({ available = availableBytes } = {}) {
  if (typeof available !== "function") throw new TypeError("available 必须是函数。");
  let reserved = 0;
  let tail = Promise.resolve();

  async function reserve(directory, bytes) {
    if (typeof directory !== "string" || !directory.trim() || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new TypeError("视频磁盘预留目录或大小无效。");
    }
    const task = tail.then(async () => {
      // Release is synchronous. Retaining the pre-statfs total for this one
      // check avoids trusting a free-space sample from before another writer
      // finished and released its lease. The next check sees the released total.
      const heldAtStart = reserved;
      const free = await available(directory);
      if (!Number.isSafeInteger(free) || free < 0) {
        throw Object.assign(new Error("无法核实视频处理磁盘余量，请稍后重试。"), { code: "VIDEO_SPACE_CHECK_FAILED" });
      }
      if (free - heldAtStart < bytes) {
        throw Object.assign(new Error("视频处理空间不足，请等待当前任务完成后重试。"), { code: "VIDEO_SPACE_LOW" });
      }
      reserved += bytes;
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        reserved -= bytes;
      };
    });
    tail = task.catch(() => {});
    return task;
  }

  return { reserve };
}

module.exports = { createVideoSpaceReservations };
