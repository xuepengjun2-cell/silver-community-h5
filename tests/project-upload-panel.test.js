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
