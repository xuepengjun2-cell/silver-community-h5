const test = require("node:test");
const assert = require("node:assert/strict");
const { cardView, catalogCover, catalogPath, sharePayload, filterCatalogCards, caseMedia, activityMedia, catalogItemView, photoUrl, documentUrl } = require("../utils/catalog");

test("案例用图片封面和原生小程序详情路径分享，不发文字词条链接", () => {
  const item = {
    id: "case_ead7a3aa8b0aa2d9", title: "春日活动实录", category: "美拍", city: "北京",
    cover: "https://proj2.likeduoduiyi.cn/silver-images/cover.jpg",
    media: [{ type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/a.mp4" }]
  };
  assert.equal(cardView(item, "cases").count, 0);
  assert.deepEqual(sharePayload(item, "cases"), {
    title: "春日活动实录｜精彩案例",
    path: "/pages/catalog/index?type=cases&id=case_ead7a3aa8b0aa2d9",
    imageUrl: item.cover
  });
});

test("图文目录只统计图片和文档，混排素材保留服务端原始下标", () => {
  const item = {
    id: "case_001", title: "图文案例", cover: "https://cdn.example.com/preview.mp4",
    media: [
      { type: "video", url: "https://cdn.example.com/movie.mp4", poster: "https://cdn.example.com/poster.jpg" },
      { type: "image", url: "https://cdn.example.com/photo.png", delivery: { url: "https://cdn.example.com/hidden.mp4" } },
      { type: "link", url: "https://example.com/video" },
      { type: "document", url: "https://cdn.example.com/plan.pdf" },
      { type: "image", url: "https://cdn.example.com/disguised.mp4?name=.jpg" },
      { type: "document", url: "https://cdn.example.com/disguised.mp4" }
    ]
  };
  assert.deepEqual(caseMedia(item).map(entry => [entry.type, entry.index]), [["image", 1], ["document", 3]]);
  assert.equal(cardView(item, "cases").count, 2);
  assert.equal(catalogCover(item, "cases"), item.media[1].url);
  const view = catalogItemView(item, "cases");
  assert.doesNotMatch(JSON.stringify(view), /mp4|poster|delivery|example\.com\/video/);
  assert.equal(sharePayload(view, "cases").imageUrl, item.media[1].url);
});

test("活动参考素材和封面永不回退到不支持的类型或查询参数伪装地址", () => {
  const item = { id: "act_001", title: "活动", cover: "https://cdn.example.com/cover.mp4", images: [
    "https://cdn.example.com/photo.jpg", "https://cdn.example.com/bad.mp4?name=.png"
  ], videos: ["https://cdn.example.com/movie.mp4"] };
  assert.equal(activityMedia(item).length, 1);
  assert.equal(cardView(item, "activities").count, 1);
  assert.equal(catalogCover({ ...item, images: [] }, "activities"), "");
  assert.doesNotMatch(JSON.stringify(catalogItemView(item, "activities")), /mp4|videos/);
  for (const url of ["https://cdn.example.com/a.mp4?file=.jpg", "https://cdn.example.com/a%2Emp4", "https://cdn.example.com/a.mp4.jpg", "https://cdn.example.com/a%252Emp4.jpg", "https://cdn.example.com/a.jpg#fragment"]) {
    assert.equal(photoUrl(url), "", url);
    assert.equal(documentUrl(url), "", url);
  }
  assert.equal(documentUrl("https://cdn.example.com/plan.pdf?download=1"), "https://cdn.example.com/plan.pdf?download=1");
});

test("活动 SOP 的 SVG 封面优先替换为照片；不把 SVG 作为分享卡片图", () => {
  const item = {
    id: "act_001", title: "肖像美拍", cover: "/assets/covers/act_001.svg",
    images: ["/assets/people/cn-singing-salon.jpg"]
  };
  assert.equal(catalogCover(item, "activities"), "https://proj2.likeduoduiyi.cn/silver/assets/people/cn-singing-salon.jpg");
  assert.match(sharePayload(item, "activities").imageUrl, /\.jpg$/);
  assert.throws(() => catalogPath("cases", "../../secret"), /编号无效/);
});

test("活动库按名称、城市、类别和标签检索，多个关键词需同时命中", () => {
  const cards = [
    cardView({ id: "act_001", title: "肖像美拍", city: "北京", category: "摄影", tags: ["银发", "室内"] }, "activities"),
    cardView({ id: "act_002", title: "音乐下午茶", city: "绍兴", category: "声乐", tags: ["社群"] }, "activities")
  ];
  assert.deepEqual(filterCatalogCards(cards, "北京 摄影").map(row => row.id), ["act_001"]);
  assert.deepEqual(filterCatalogCards(cards, "银发").map(row => row.id), ["act_001"]);
  assert.deepEqual(filterCatalogCards(cards, "北京 声乐"), []);
  assert.equal(filterCatalogCards(cards, "  ").length, 2);
});
