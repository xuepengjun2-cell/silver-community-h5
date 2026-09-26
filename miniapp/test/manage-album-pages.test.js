const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SESSION_KEY } = require("../utils/auth");
const appConfig = require("../app.json");

function pageAt(relativePath) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
}

test("上传和下载的网络超时为 10 分钟，不用微信默认的 60 秒", () => {
  assert.equal(appConfig.networkTimeout.uploadFile, 10 * 60 * 1000);
  assert.equal(appConfig.networkTimeout.downloadFile, 10 * 60 * 1000);
});

test("主办方拍摄视频可到 60 秒；隐私指引未声明时提示真实原因", async () => {
  const modals = [];
  let chooseOptions;
  const storage = new Map([[SESSION_KEY, { token: "test-token", user: { role: "operator" } }]]);
  global.wx = {
    getStorageSync: key => storage.get(key),
    chooseMedia(options) {
      chooseOptions = options;
      options.fail({ errno: 112, errMsg: "chooseMedia:fail api scope is not declared in the privacy agreement" });
    },
    showModal: options => modals.push(options)
  };
  const manage = pageAt("../pages/manage/index.js");
  manage.data.project = { canManage: true };
  await manage.choose("video");
  assert.equal(chooseOptions.maxDuration, 60);
  assert.match(modals[0].content, /用户隐私保护指引/);
  delete global.wx;
});

test("只读相册可看素材但不能触发上传、编辑或删除", async () => {
  const calls = [];
  global.wx = {
    chooseMedia() { calls.push("choose"); },
    showModal() { calls.push("modal"); },
    navigateTo() { calls.push("navigate"); },
    previewImage(options) { calls.push(["preview", options.current]); }
  };
  const manage = pageAt("../pages/manage/index.js");
  manage.projectId = "project_85aae4b746069044";
  manage.showProject({ id: manage.projectId, title: "只读相册", canManage: false, media: [{ type: "image", url: "https://proj2.likeduoduiyi.cn/silver-project-images/a.jpg" }] });
  await manage.choose("image");
  await manage.onSave();
  manage.onEdit();
  manage.onDelete({ currentTarget: { dataset: { index: 0 } } });
  manage.onProjectDelete();
  assert.deepEqual(calls, []);
  assert.equal(manage.data.editing, false);
  manage.onPreview({ currentTarget: { dataset: { index: 0 } } });
  assert.deepEqual(calls, [["preview", "https://proj2.likeduoduiyi.cn/silver-project-images/a.jpg"]]);
  const wxml = fs.readFileSync(path.join(__dirname, "../pages/manage/index.wxml"), "utf8");
  assert.match(wxml, /wx:if="\{\{project\.canManage\}\}" class="actions"/);
  assert.match(wxml, /wx:if="\{\{project\.canManage\}\}" class="remove"/);
  assert.match(wxml, /wx:if="\{\{project\.canManage\}\}" class="button button-secondary delete-project"/);
  delete global.wx;
});

test("客户相册和单素材页隐藏通往主办方登录页的“返回首页”", () => {
  let hidden = 0;
  global.wx = { hideHomeButton: () => { hidden += 1; } };
  pageAt("../pages/album/index.js").onShow();
  pageAt("../pages/media/index.js").onShow();
  assert.equal(hidden, 2);
  delete global.wx;
});
