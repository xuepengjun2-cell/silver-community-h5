const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const start = appSource.indexOf("function projectUploadSessionsHtml(projectId) {");
const end = appSource.indexOf("\nfunction bindProjectUploadSessionActions", start);
assert.notEqual(start, -1, "upload panel renderer exists");
assert.notEqual(end, -1, "upload panel renderer has a clear boundary");
const rendererSource = appSource.slice(start, end);

function render(sessions) {
  return vm.runInNewContext(`${rendererSource}; projectUploadSessionsHtml`, {
    state: { projectUploadSessions: sessions, projectUploadSessionsError: "" },
    esc: value => String(value)
  })("project-test");
}

test("已完成视频任务自动从后台任务面板消失", () => {
  assert.equal(render([{ sessionId: "done", title: "成片.mp4", status: "completed" }]), "");
});

test("任务面板只保留处理中和需要处理的任务", () => {
  const html = render([
    { sessionId: "done", title: "成片.mp4", status: "completed" },
    { sessionId: "working", title: "处理中.mp4", status: "processing" },
    { sessionId: "retry", title: "待优化.mp4", status: "delivery_failed", error: "原片已保留" }
  ]);
  assert.match(html, /处理中\.mp4/);
  assert.match(html, /待优化\.mp4/);
  assert.match(html, /重试处理/);
  assert.doesNotMatch(html, /成片\.mp4|处理完成|刷新素材/);
});

test("H5 与小程序生成相同的轻量相册封面，保留原片和可信回退地址", () => {
  const begin = appSource.indexOf("function projectVideoPosterSources(media) {");
  const finish = appSource.indexOf("\nfunction projectVideoPosterHtml", begin);
  const sources = vm.runInNewContext(`${appSource.slice(begin, finish)}; projectVideoPosterSources`);
  const native = require("../miniapp/utils/album").videoPosterSources;
  for (const media of [
    { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/old.mp4", size: 700 * 1024 * 1024 },
    { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/new.mp4", poster: "https://proj2.likeduoduiyi.cn/silver-project-images/first.jpg" },
    { type: "video", url: "https://evil.example/x.mp4", poster: "https://evil.example/first.jpg" },
    { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/signed.mp4?sig=keep" }
  ]) assert.deepEqual(JSON.parse(JSON.stringify(sources(media))), native(media));
});

test("H5 封面失败时只回退一次，全部失败后仍可点击播放", () => {
  const begin = appSource.indexOf("function bindProjectVideoThumbs() {");
  const finish = appSource.indexOf("\nfunction triggerProjectDownload", begin);
  let onError;
  const image = { src: "snapshot.jpg", complete: false, dataset: { posterFallback: "persisted.jpg" }, removed: false,
    addEventListener(type, callback) { if (type === "error") onError = callback; }, remove() { this.removed = true; } };
  const bind = vm.runInNewContext(`${appSource.slice(begin, finish)}; bindProjectVideoThumbs`, {
    document: { querySelectorAll(selector) { return selector.startsWith("img") ? [image] : []; } }
  });
  bind(); onError(); assert.equal(image.src, "persisted.jpg"); assert.equal(image.removed, false);
  onError(); assert.equal(image.removed, true);
});
