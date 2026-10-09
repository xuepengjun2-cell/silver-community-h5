const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_VIDEO_BYTES, parseShareInput, parseAlbumOptions, albumPath,
  mediaPath, saveEligibility, trustedMediaUrl, videoPosterSources
} = require("../utils/album");

const id = "project_85aae4b746069044";
const image = { type: "image", url: "https://proj2.likeduoduiyi.cn/silver-project-images/photo.jpg" };
const mp4 = { type: "video", url: "https://proj2.likeduoduiyi.cn/silver-project-videos/demo.mp4", size: 99 * 1024 * 1024 };

test("支持原 H5 相册链接与单素材链接，并生成微信分享路径", () => {
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

test("仅下载本项目 CDN 媒体；MP4 不超过微信 200 MB 限制", () => {
  assert.equal(trustedMediaUrl(image), image.url);
  assert.equal(saveEligibility(image).ok, true);
  assert.equal(saveEligibility(mp4).ok, true);
  assert.equal(saveEligibility({ ...mp4, size: MAX_VIDEO_BYTES }).ok, true);
  assert.match(saveEligibility({ ...mp4, size: MAX_VIDEO_BYTES + 1 }).reason, /200 MB/);
  assert.match(saveEligibility({ ...mp4, url: mp4.url.replace(".mp4", ".mov") }).reason, /MP4/);
  assert.equal(saveEligibility({ ...mp4, url: "https://evil.example.com/x.mp4" }).ok, false);
  assert.equal(saveEligibility({ ...image, url: image.url.replace(".jpg", ".svg") }).ok, false);
  assert.equal(saveEligibility({ ...image, url: image.url.replace(".jpg", ".heic") }).ok, false);
  assert.equal(saveEligibility({ ...mp4, size: undefined }).ok, false);
  assert.equal(saveEligibility({
    ...mp4, url: mp4.url.replace(".mp4", ".mov"), size: MAX_VIDEO_BYTES + 1,
    delivery: { url: mp4.url, size: mp4.size }
  }).ok, true);
});

test("相册卡片和视频详情请求轻量视频画面，保留可信服务端封面用于回退", async () => {
  const poster = "https://proj2.likeduoduiyi.cn/silver-project-images/first-frame.jpg";
  const project = { id, title: "绍兴活动", media: [image, { ...mp4, poster }, { ...mp4, poster: "https://example.org/fake.jpg" }] };
  global.wx = {
    request(options) { options.success({ statusCode: 200, data: { project } }); },
    setNavigationBarTitle() {}
  };
  const page = source => {
    let definition;
    global.Page = value => { definition = value; };
    const resolved = require.resolve(source);
    delete require.cache[resolved];
    require(resolved);
    delete global.Page;
    return { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  };
  try {
    const album = page("../pages/album/index.js");
    album.projectId = id;
    await album.loadAlbum();
    const generated = videoPosterSources(mp4).poster;
    assert.equal(album.data.tiles[1].imageUrl, generated);
    assert.equal(album.data.tiles[1].fallbackImageUrl, poster);
    assert.equal(album.data.tiles[2].imageUrl, generated);
    assert.equal(album.data.tiles[2].fallbackImageUrl, "");
    album.onTab({ currentTarget: { dataset: { tab: "video" } } });
    album.onPosterError({ currentTarget: { dataset: { index: 1, url: generated } } });
    assert.equal(album.data.tiles[1].imageUrl, poster);
    assert.equal(album.data.shown[0].imageUrl, poster);
    album.onPosterError({ currentTarget: { dataset: { index: 1, url: generated } } });
    assert.equal(album.data.tiles[1].imageUrl, poster, "忽略旧请求晚到的错误");
    album.onPosterError({ currentTarget: { dataset: { index: 1, url: poster } } });
    assert.equal(album.data.tiles[1].imageUrl, "", "回退失败后保留原播放入口，不循环请求");
    const detail = page("../pages/media/index.js");
    detail.projectId = id;
    detail.index = 1;
    await detail.loadMedia();
    assert.equal(detail.data.poster, generated);
    assert.equal(detail.data.media.url, mp4.url);
    assert.equal(detail.data.canSave, true);
    const manager = page("../pages/manage/index.js");
    manager.showProject(project);
    assert.equal(manager.data.tiles[1].poster, generated);
    manager.onPosterError({ currentTarget: { dataset: { index: 1, url: generated } } });
    assert.equal(manager.data.tiles[1].poster, poster);
  } finally { delete global.wx; delete global.Page; }
});

test("旧视频封面不受 200 MB 保存限制影响，也不修改原片与签名链接", () => {
  const large = { ...mp4, size: 700 * 1024 * 1024 };
  assert.equal(videoPosterSources(large).poster, videoPosterSources(mp4).poster);
  assert.match(videoPosterSources(mp4).poster, /\?x-tos-process=video\/snapshot,t_1000,w_640,f_jpg$/);
  assert.match(saveEligibility(large).reason, /200 MB/);
  const fallback = image.url;
  assert.equal(videoPosterSources({ ...mp4, url: mp4.url + "?signature=keep", poster: fallback }).poster, fallback);
  assert.deepEqual(videoPosterSources({ ...mp4, url: "https://evil.example/a.mp4", poster: "https://evil.example/p.jpg" }), { poster: "", fallbackPoster: "" });
  assert.deepEqual(videoPosterSources(image), { poster: "", fallbackPoster: "" });
  assert.equal(mp4.url, "https://proj2.likeduoduiyi.cn/silver-project-videos/demo.mp4");
});
