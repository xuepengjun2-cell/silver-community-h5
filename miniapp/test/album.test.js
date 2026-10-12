const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseShareInput, parseAlbumOptions, albumPath, mediaPath,
  saveEligibility, saveSource, trustedMediaUrl
} = require("../utils/album");

const id = "project_85aae4b746069044";
const image = { type: "image", url: "https://proj2.likeduoduiyi.cn/silver-project-images/photo.jpg" };
const video = { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/demo.mp4", size: 99 * 1024 * 1024 };
const secondImage = { ...image, url: image.url.replace("photo.jpg", "second.png") };

function page(source) {
  let definition;
  global.Page = value => { definition = value; };
  const resolved = require.resolve(source);
  delete require.cache[resolved];
  require(resolved);
  delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
}

function fakeWx(project) {
  const calls = [];
  return {
    calls,
    request(options) {
      calls.push({ kind: "request", url: options.url, data: options.data });
      if (options.url.endsWith("/audit-events")) return;
      options.success({ statusCode: 200, data: { project } });
    },
    setNavigationBarTitle(options) { calls.push({ kind: "title", ...options }); },
    navigateTo(options) { calls.push({ kind: "navigate", ...options }); },
    redirectTo(options) { calls.push({ kind: "redirect", ...options }); }
  };
}

test("原相册与单张照片链接仍使用原始素材序号", () => {
  assert.deepEqual(parseShareInput(`https://proj2.likeduoduiyi.cn/silver/?share=${id}`), { id, index: null });
  assert.deepEqual(parseShareInput(`https://proj2.likeduoduiyi.cn/silver/?share=${id}.3`), { id, index: 3 });
  assert.deepEqual(parseShareInput(id), { id, index: null });
  assert.equal(albumPath(id), `/pages/album/index?id=${id}`);
  assert.equal(mediaPath(id, 3), `/pages/media/index?id=${id}&i=3`);
  assert.deepEqual(parseAlbumOptions({ id, i: "3" }), { id, index: 3 });
});

test("拒绝伪造项目编号及不合法素材序号", () => {
  for (const value of ["", "case_a1", "https://wrong.test/?share=case_a1", "project_deadbeef", `${id}.999999999999999999999`]) {
    assert.equal(parseShareInput(value), null);
  }
  assert.equal(parseAlbumOptions({ id, i: "-1" }), null);
  assert.equal(parseAlbumOptions({ id: "case_123", i: "1" }), null);
  assert.throws(() => mediaPath(id, -1));
});

test("相册仅接收图片 CDN 的明确图片，保存仅 JPG/PNG，拒绝视频及路径伪装", () => {
  assert.equal(trustedMediaUrl(image), image.url);
  assert.equal(trustedMediaUrl(secondImage), secondImage.url);
  assert.equal(trustedMediaUrl({ ...image, url: image.url + "?signature=keep" }), image.url + "?signature=keep");
  assert.equal(saveEligibility(image).ok, true);
  assert.equal(saveSource(video), null);
  assert.equal(saveSource(image), image);
  assert.equal(saveEligibility(video).ok, false);
  assert.equal(saveEligibility({ ...video, delivery: { url: image.url, size: 1024 } }).ok, false);
  for (const url of [
    "https://evil.example.com/photo.jpg", image.url.replace("photo.jpg", "film.mp4"),
    image.url.replace("photo.jpg", "film.mp4?fake=.jpg"), image.url.replace("photo.jpg", "film.mp4.jpg"),
    image.url.replace("photo.jpg", "../silver-project-videos/film.jpg"),
    image.url.replace("photo.jpg", "%2e%2e/film.jpg"), image.url.replace("photo.jpg", "%2Ffilm.jpg"),
    image.url.replace("photo.jpg", "photo.heic"), image.url + "#fragment"
  ]) {
    assert.equal(trustedMediaUrl({ type: "image", url }), "", url);
    assert.equal(saveEligibility({ type: "image", url }).ok, false, url);
  }
  for (const ext of ["webp", "gif", "svg"]) {
    const media = { ...image, url: image.url.replace("photo.jpg", `photo.${ext}`) };
    assert.equal(trustedMediaUrl(media), media.url);
    assert.equal(saveEligibility(media).ok, false);
  }
});

test("混排相册仅显示可信图片，并保留源数组序号供导航和审计", async () => {
  const project = { id, title: "绍兴活动", cover: video.url, media: [video, image, { ...image, url: "https://example.org/fake.jpg" }, secondImage] };
  global.wx = fakeWx(project);
  try {
    const album = page("../pages/album/index.js");
    album.projectId = id;
    await album.loadAlbum();
    assert.deepEqual(album.data.tiles.map(item => item.index), [1, 3]);
    assert.equal(album.data.imageCount, 2);
    assert.equal(album.data.cover, image.url);
    assert.equal(JSON.stringify(album.data).includes(video.url), false);
    assert.equal(Object.hasOwn(album.data.project, "media"), false);
    album.onMedia({ currentTarget: { dataset: { index: 0 } } });
    assert.equal(wx.calls.some(item => item.kind === "navigate"), false);
    album.onMedia({ currentTarget: { dataset: { index: 3 } } });
    assert.equal(wx.calls.find(item => item.kind === "navigate").url, mediaPath(id, 3));
  } finally { delete global.wx; delete global.Page; }
});

test("历史 WebP/GIF/SVG 保留相册预览和照片导航，但不冒充可保存的 JPG/PNG", async () => {
  const photos = ["webp", "gif", "svg"].map(ext => ({ ...image, url: image.url.replace("photo.jpg", `photo.${ext}`) }));
  global.wx = fakeWx({ id, title: "历史图片", media: [video, ...photos] });
  try {
    const album = page("../pages/album/index.js");
    album.projectId = id;
    await album.loadAlbum();
    assert.deepEqual(album.data.tiles.map(item => item.index), [1, 2, 3]);
    const detail = page("../pages/media/index.js");
    detail.projectId = id;
    detail.index = 1;
    await detail.loadMedia();
    assert.equal(detail.data.media.url, photos[0].url);
    assert.equal(detail.data.count, 3);
    assert.equal(detail.data.nextIndex, 2);
    assert.equal(detail.data.canSave, false);
    assert.match(detail.data.reason, /转换/);
  } finally { delete global.wx; }
});

test("照片上一张/下一张跳过视频，展示序号与原始审计序号各自正确", async () => {
  const project = { id, title: "绍兴活动", media: [video, { ...image, delivery: { url: video.url } }, video, secondImage] };
  global.wx = fakeWx(project);
  try {
    const detail = page("../pages/media/index.js");
    detail.projectId = id;
    detail.index = 1;
    await detail.loadMedia();
    assert.equal(detail.data.index, 1);
    assert.equal(detail.data.position, 1);
    assert.equal(detail.data.count, 2);
    assert.equal(detail.data.previousIndex, -1);
    assert.equal(detail.data.nextIndex, 3);
    assert.equal(JSON.stringify(detail.data).includes(video.url), false);
    assert.equal(wx.calls.find(item => String(item.url || "").endsWith("/audit-events")).data.mediaIndex, 1);
    detail.goTo(2);
    detail.onPrevious();
    assert.equal(wx.calls.some(item => item.kind === "redirect"), false);
    detail.onNext();
    assert.equal(wx.calls.find(item => item.kind === "redirect").url, mediaPath(id, 3));
    assert.equal(detail.onShareAppMessage().path, mediaPath(id, 1));
    detail.index = 3;
    await detail.loadMedia();
    assert.equal(detail.data.position, 2);
    assert.equal(detail.data.previousIndex, 1);
    assert.equal(detail.data.nextIndex, -1);
    detail.onPrevious();
    assert.equal(wx.calls.filter(item => item.kind === "redirect").at(-1).url, mediaPath(id, 1));
  } finally { delete global.wx; delete global.Page; }
});

test("全视频相册为空态，旧视频直达不产生播放、下载或观看审计", async () => {
  global.wx = fakeWx({ id, title: "旧相册", cover: video.url, media: [video] });
  try {
    const album = page("../pages/album/index.js");
    album.projectId = id;
    await album.loadAlbum();
    assert.equal(album.data.imageCount, 0);
    assert.deepEqual(album.data.tiles, []);
    assert.equal(album.data.cover, "");
    const detail = page("../pages/media/index.js");
    detail.projectId = id;
    detail.index = 0;
    await detail.loadMedia();
    assert.match(detail.data.error, /不可用/);
    assert.equal(detail.data.media, null);
    assert.equal(detail.data.canSave, false);
    assert.equal(JSON.stringify(detail.data).includes(video.url), false);
    await detail.onSave();
    detail.recordView();
    detail.goTo(0);
    assert.equal(wx.calls.some(item => String(item.url || "").endsWith("/audit-events") || item.kind === "redirect"), false);
    assert.equal(detail.onShareAppMessage().path, albumPath(id));
    for (const name of ["album", "media"]) {
      const template = fs.readFileSync(path.join(__dirname, "..", "pages", name, "index.wxml"), "utf8");
      assert.doesNotMatch(template, /<video\b|bindplay|videoCount|播放|观看视频/);
    }
  } finally { delete global.wx; delete global.Page; }
});
