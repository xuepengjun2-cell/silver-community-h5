const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SESSION_KEY } = require("../utils/auth");

function pageAt(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
}

test("个人图文版整个运行包没有视频组件、视频系统API或网页替代入口", () => {
  function inspect(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === "test") continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) inspect(file);
      else if (/\.(?:js|wxml)$/.test(name)) {
        const source = fs.readFileSync(file, "utf8");
        assert.doesNotMatch(source, /<\s*(?:video|live-player|live-pusher|web-view)\b/i, file);
        assert.doesNotMatch(source, /\b(?:compressVideo|saveVideoToPhotosAlbum|createVideoContext|previewMedia|openVideoEditor|chooseVideo)\b/, file);
        assert.doesNotMatch(source, /(?:silver-project-videos|silver-case-videos|x-tos-process=video)/, file);
      }
    }
  }
  inspect(path.join(__dirname, ".."));
  assert.equal(require("../config").videoBase, undefined);
});

test("工作台所有角色均只统计照片，封面和页面数据不携带混排视频", async () => {
  const photo = { type: "image", url: "https://proj2.likeduoduiyi.cn/silver-project-images/a.jpg" };
  const movie = { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/a.mp4" };
  try {
    for (const role of ["admin", "operator", "member", "viewer"]) {
      const user = { id: "test-user", role };
      const storage = new Map([[SESSION_KEY, { token: "test-token", user }]]);
      global.wx = {
        getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
        removeStorageSync: key => storage.delete(key),
        request(options) {
          options.success({ statusCode: 200, data: options.url.endsWith("/me") ? { user }
            : options.url.endsWith("/my/activity-projects") ? { projects: [{ id: "project_85aae4b746069044", title: "混排相册", media: [movie, photo], cover: movie.url, canManage: role !== "viewer" }] }
              : options.url.endsWith("/public/activities") ? { activities: [] } : { cases: [] } });
        }
      };
      const workbench = pageAt("../pages/workbench/index.js");
      await workbench.load();
      assert.equal(workbench.data.loading, false);
      assert.equal(workbench.data.projects[0].photoCount, 1, role);
      assert.equal(workbench.data.projects[0].cover, photo.url, role);
      assert.equal(workbench.data.projects[0].canManage, role !== "viewer", role);
      assert.doesNotMatch(JSON.stringify(workbench.data), /\.mp4|silver-project-videos/);
    }
  } finally { delete global.wx; }
});

test("旧下载记账函数不再支持请求非图片素材", async () => {
  const { recordDownloadIntent } = require("../utils/api");
  const wxApi = { request() { throw new Error("非图片不应触发请求"); } };
  for (const type of ["video", "link", "document", undefined]) {
    await assert.rejects(recordDownloadIntent(wxApi, "project_85aae4b746069044", 0, type), /不可用/);
  }
});
