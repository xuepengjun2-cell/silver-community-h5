const { getProject } = require("../../utils/api");
const { parseAlbumOptions, albumPath, mediaPath, trustedMediaUrl, displayName } = require("../../utils/album");

Page({
  data: {
    loading: true, error: "", project: null, tiles: [], shown: [], tab: "all",
    imageCount: 0, videoCount: 0, cover: ""
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
    this.setData({ loading: true, error: "" });
    try {
      const project = await getProject(wx, this.projectId);
      const tiles = (project.media || []).map((media, index) => ({
        index, type: media.type, name: displayName(media, index),
        imageUrl: media.type === "image" ? trustedMediaUrl(media) :
          trustedMediaUrl({ type: "image", url: media.poster })
      })).filter(item => item.type === "image" || item.type === "video");
      const imageCount = tiles.filter(item => item.type === "image").length;
      const videoCount = tiles.length - imageCount;
      const firstImage = tiles.find(item => item.imageUrl);
      const cover = trustedMediaUrl({ type: "image", url: project.cover }) || firstImage && firstImage.imageUrl || "";
      wx.setNavigationBarTitle({ title: project.title || "活动相册" });
      this.setData({ project, tiles, shown: tiles, imageCount, videoCount, cover, loading: false, tab: "all" });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "相册暂时无法打开。" });
    }
  },
  onTab(event) {
    const tab = event.currentTarget.dataset.tab;
    const shown = tab === "all" ? this.data.tiles : this.data.tiles.filter(item => item.type === tab);
    this.setData({ tab, shown });
  },
  onMedia(event) {
    wx.navigateTo({ url: mediaPath(this.projectId, Number(event.currentTarget.dataset.index)) });
  },
  onRetry() { this.loadAlbum(); },
  onShareAppMessage() {
    const project = this.data.project;
    return { title: project ? `${project.title}｜活动相册` : "活动相册", path: albumPath(this.projectId) };
  }
});
