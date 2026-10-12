const { getProject } = require("../../utils/api");
const { parseAlbumOptions, albumPath, mediaPath, trustedMediaUrl, displayName } = require("../../utils/album");

Page({
  data: {
    loading: true, error: "", project: null, tiles: [], imageCount: 0, cover: ""
  },
  onLoad(options) {
    const parsed = parseAlbumOptions(options);
    if (!parsed) return this.setData({ loading: false, error: "相册链接无效，请向活动主办方重新索取。" });
    this.projectId = parsed.id;
    if (parsed.index !== null) {
      wx.redirectTo({ url: mediaPath(parsed.id, parsed.index) });
      return;
    }
    this.loadAlbum();
  },
  onShow() {
    // 客户从分享卡片进入时，左上角“返回首页”会落到主办方登录页；客户页面不显示它。
    if (typeof wx.hideHomeButton === "function") wx.hideHomeButton();
  },
  onPullDownRefresh() { this.loadAlbum().finally(() => wx.stopPullDownRefresh()); },
  async loadAlbum() {
    this.setData({ loading: true, error: "", project: null, tiles: [], imageCount: 0, cover: "" });
    try {
      const source = await getProject(wx, this.projectId);
      // index 始终采用原始数组序号，保证旧照片链接和下载审计对应同一张图片。
      const tiles = (Array.isArray(source.media) ? source.media : []).map((media, index) => ({
        index, type: "image", name: displayName(media, index), imageUrl: trustedMediaUrl(media)
      })).filter(item => item.imageUrl);
      const project = {
        id: source.id, title: String(source.title || ""), dateLabel: String(source.dateLabel || ""),
        city: String(source.city || ""), description: String(source.description || "")
      };
      const cover = trustedMediaUrl({ type: "image", url: source.cover }) || tiles[0] && tiles[0].imageUrl || "";
      wx.setNavigationBarTitle({ title: project.title || "照片相册" });
      this.setData({ project, tiles, imageCount: tiles.length, cover, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "相册暂时无法打开。" });
    }
  },
  onMedia(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!this.data.tiles.some(item => item.index === index)) return;
    wx.navigateTo({ url: mediaPath(this.projectId, index) });
  },
  onRetry() { this.loadAlbum(); },
  onShareAppMessage() {
    const project = this.data.project;
    return {
      title: project ? `${project.title}｜照片相册` : "照片相册",
      path: this.projectId ? albumPath(this.projectId) : "/pages/entry/index"
    };
  }
});
