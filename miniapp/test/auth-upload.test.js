const test = require("node:test");
const assert = require("node:assert/strict");
const { login, logout, getSession, validateSession, canManageProjects, SESSION_KEY } = require("../utils/auth");
const { prepareMedia, uploadMedia, MAX_IMAGE, isImageSelection } = require("../utils/upload");

function fakeWx(response) {
  const storage = new Map();
  const calls = [];
  return {
    storage, calls,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request(options) { calls.push(options); options.success(response(options)); }
  };
}

test("主办方复用 H5 账号但客户端仅存 token，退出后服务端撤销 Bearer", async () => {
  const wx = fakeWx(options => options.url.endsWith("/login")
    ? { statusCode: 200, data: { user: { role: "operator", name: "主办方" }, token: "token-test" } }
    : options.url.endsWith("/me")
      ? { statusCode: 200, data: { user: { role: "operator", name: "主办方" } } }
      : { statusCode: 200, data: { ok: true } });
  await login(wx, "user", "secret");
  assert.equal(getSession(wx).token, "token-test");
  assert.equal(wx.storage.get(SESSION_KEY).password, undefined);
  assert.equal((await validateSession(wx)).user.role, "operator");
  await logout(wx);
  assert.equal(wx.calls.at(-1).header.Authorization, "Bearer token-test");
  assert.equal(getSession(wx), null);
});

test("只读账号可登录资料工作台，但不能获得相册管理入口", async () => {
  const wx = fakeWx(() => ({ statusCode: 200, data: { user: { role: "viewer" }, token: "x" } }));
  await login(wx, "user", "password");
  assert.equal(getSession(wx).user.role, "viewer");
  assert.equal(canManageProjects(getSession(wx).user), false);
  assert.equal(canManageProjects({ role: "member" }), true);
});

test("登录态复核以服务端最新角色为准", async () => {
  const wx = fakeWx(options => options.url.endsWith("/login")
    ? { statusCode: 200, data: { user: { role: "operator" }, token: "x" } }
    : { statusCode: 200, data: { user: { role: "viewer" } } });
  await login(wx, "user", "password");
  assert.equal(canManageProjects((await validateSession(wx)).user), false);
  assert.equal(getSession(wx).user.role, "viewer");
});

test("图片以外的类型在调用任何微信 API 前被拒绝", async () => {
  let accesses = 0;
  const wx = new Proxy({}, { get() { accesses++; throw new Error("不应访问微信 API"); } });
  for (const type of ["video", "document", "image/video", "", undefined]) {
    await assert.rejects(() => prepareMedia(wx, "/temporary/source.mov", type), /仅支持上传照片/);
    await assert.rejects(() => uploadMedia(wx, { projectId: "project_85aae4b746069044", source: "/temporary/source.mov", type, token: "t" }), /仅支持上传照片/);
  }
  assert.equal(accesses, 0);
});

test("图片上传使用 10 分钟超时，超时提示连接 Wi-Fi 后重试", async () => {
  let uploadOptions;
  const wx = {
    compressImage: options => options.success({ tempFilePath: "/temporary/compressed.jpg" }),
    getFileInfo: options => options.success({ size: 1024 }),
    uploadFile(options) { uploadOptions = options; options.fail({ errMsg: "uploadFile:fail timeout" }); return {}; }
  };
  await assert.rejects(() => uploadMedia(wx, { projectId: "project_85aae4b746069044", source: "/temporary/source.jpg", type: "image", token: "t" }), /上传超时/);
  assert.equal(uploadOptions.timeout, 10 * 60 * 1000);
});

test("选择器结果须为图片类型或图片扩展，矛盾类型和未知扩展不能混入", () => {
  assert.equal(isImageSelection({ tempFilePath: "/tmp/photo.jpg" }), true);
  assert.equal(isImageSelection({ tempFilePath: "wxfile://tmp_opaque", fileType: "image" }), true);
  assert.equal(isImageSelection({ tempFilePath: "/tmp/photo.heic", fileType: "image" }), true);
  for (const file of [null, {}, { tempFilePath: "/tmp/opaque" }, { tempFilePath: "/tmp/clip.mp4", fileType: "image" },
    { tempFilePath: "/tmp/photo.jpg", fileType: "video" }, { tempFilePath: "/tmp/data.bin", fileType: "image" }]) {
    assert.equal(isImageSelection(file), false);
  }
});

test("仅上传照片压缩产物，50 MiB 边界和无效文件大小阻止上传", async () => {
  for (const size of [1, MAX_IMAGE, MAX_IMAGE + 1, 0, -1, NaN, Infinity, "1024"]) {
    const uploads = [];
    const wx = {
      compressImage: options => options.success({ tempFilePath: "/temporary/compressed.jpg" }),
      getFileInfo: options => options.success({ size }),
      uploadFile(options) { uploads.push(options); options.success({ statusCode: 201, data: JSON.stringify({ project: { media: [] } }) }); return {}; }
    };
    const pending = uploadMedia(wx, { projectId: "project_85aae4b746069044", source: "/temporary/original.heic", type: "image", token: "t" });
    if (Number.isFinite(size) && size > 0 && size <= MAX_IMAGE) {
      await pending;
      assert.equal(uploads[0].filePath, "/temporary/compressed.jpg");
      assert.match(uploads[0].url, /\?type=image$/);
      assert.equal(uploads[0].header.Authorization, "Bearer t");
    } else {
      await assert.rejects(pending, /50 MB|文件无效/);
      assert.equal(uploads.length, 0);
    }
  }
});

test("伪装扩展名仍须经图片压缩成功，无原文件上传兜底", async () => {
  let uploads = 0;
  const wx = {
    compressImage: options => options.fail({ errMsg: "compressImage:fail invalid image" }),
    uploadFile() { uploads++; }
  };
  await assert.rejects(() => uploadMedia(wx, { projectId: "project_85aae4b746069044", source: "/temporary/disguised.jpg", type: "image", token: "t" }), /invalid image/);
  assert.equal(uploads, 0);
});

test("压缩后页面操作已失效时不开始上传", async () => {
  let cancelled = false, uploads = 0;
  const wx = {
    compressImage(options) { cancelled = true; options.success({ tempFilePath: "/temporary/compressed.jpg" }); },
    getFileInfo: options => options.success({ size: 1024 }),
    uploadFile() { uploads++; }
  };
  await assert.rejects(() => uploadMedia(wx, { projectId: "project_85aae4b746069044", source: "/temporary/photo.jpg", type: "image", token: "t", isCancelled: () => cancelled }), /已离开上传页面/);
  assert.equal(uploads, 0);
});
