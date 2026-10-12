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

test("H5 独立保留轻量视频封面和可信回退，不依赖原生小程序能力", () => {
  const begin = appSource.indexOf("function projectVideoPosterSources(media) {");
  const finish = appSource.indexOf("\nfunction projectVideoPosterHtml", begin);
  const sources = vm.runInNewContext(`${appSource.slice(begin, finish)}; projectVideoPosterSources`);
  const source = "https://proj2.likeduoduiyi.cn/silver-project-videos/old.mp4";
  const fallback = "https://proj2.likeduoduiyi.cn/silver-project-images/first.jpg";
  for (const [media, expected] of [
    [{ type: "video", url: source, size: 700 * 1024 * 1024 }, { poster: `${source}?x-tos-process=video/snapshot,t_1000,w_640,f_jpg`, fallbackPoster: "" }],
    [{ type: "video", url: source, poster: fallback }, { poster: `${source}?x-tos-process=video/snapshot,t_1000,w_640,f_jpg`, fallbackPoster: fallback }],
    [{ type: "video", url: "https://evil.example/x.mp4", poster: "https://evil.example/first.jpg" }, { poster: "", fallbackPoster: "" }],
    [{ type: "video", url: `${source}?sig=keep`, poster: fallback }, { poster: fallback, fallbackPoster: "" }]
  ]) assert.deepEqual(JSON.parse(JSON.stringify(sources(media))), expected);
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
