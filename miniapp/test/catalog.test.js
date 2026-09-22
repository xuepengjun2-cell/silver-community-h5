const test = require("node:test");
const assert = require("node:assert/strict");
const { cardView, catalogCover, catalogPath, sharePayload } = require("../utils/catalog");

test("案例用图片封面和原生小程序详情路径分享，不发文字词条链接", () => {
  const item = {
    id: "case_ead7a3aa8b0aa2d9", title: "春日活动实录", category: "美拍", city: "北京",
    cover: "https://proj2.likeduoduiyi.cn/silver-images/cover.jpg",
    media: [{ type: "video", url: "https://proj2.likeduoduiyi.cn/silver-case-videos/a.mp4" }]
  };
  assert.equal(cardView(item, "cases").count, 1);
  assert.deepEqual(sharePayload(item, "cases"), {
    title: "春日活动实录｜精彩案例",
    path: "/pages/catalog/index?type=cases&id=case_ead7a3aa8b0aa2d9",
    imageUrl: item.cover
  });
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
