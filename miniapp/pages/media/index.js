const { getProject } = require("../../utils/api");
const { saveMedia } = require("../../utils/save");
const { apiBase } = require("../../config");
const { parseAlbumOptions, albumPath, mediaPath, saveEligibility, displayName, trustedMediaUrl } = require("../../utils/album");

Page({
  data: {
    loading: true, error: "", project: null, media: null, index: 0,
    name: "", count: 0, canSave: false, reason: "", busy: false, progress: 0
  },
  onLoad(options) {
    const parsed = parseAlbumOptions(options);
    if (!parsed || parsed.index === null) {
      return this.setData({ loading: false, error: "素材链接无效，请返回活动相册。" });
    }
    this.projectId = parsed.id;
    this.index = parsed.index;
    this.loadMedia();
  },
  onShow() {
    // 客户从单素材分享卡片进入时，同样不显示通往主办方登录页的“返回首页”。
    if (typeof wx.hideHomeButton === "function") wx.hideHomeButton();
  },
  async loadMedia() {
    this.setData({ loading: true, error: "" });
    try {
      const project = await getProject(wx, this.projectId);
      const media = (project.media || [])[this.index];
      if (!media || !trustedMediaUrl(media)) throw new Error("素材不存在或已经移除。");
      const eligibility = saveEligibility(media);
      wx.setNavigationBarTitle({ title: media.type === "video" ? "保存活动视频" : "保存活动照片" });
      this.setData({
        loading: false, project, media, poster: trustedMediaUrl({ type: "image", url: media.poster }), index: this.index, count: project.media.length,
        name: displayName(media, this.index), canSave: eligibility.ok, reason: eligibility.reason
      });
      if (media.type === "image") this.recordView();
    } catch (error) {
      this.setData({ loading: false, error: error.message || "素材暂时无法打开。" });
    }
  },
  onVideoPlay() { this.recordView(); },
  recordView() {
    if (this.viewTracked) return;
    this.viewTracked = true;
    // 观看统计属于辅助信息；不能因此影响游客看素材或保存。
    wx.request({
      url: `${apiBase}/audit-events`,
      method: "POST",
      data: { action: "view", resourceType: "activity_project_media", resourceId: this.projectId, mediaIndex: this.index },
      fail() {}
    });
  },
  async onSave() {
    if (this.data.busy || !this.data.media) return;
    if (!this.data.canSave) {
      return wx.showModal({ title: "暂不能直接保存", content: this.data.reason, showCancel: false });
    }
    this.setData({ busy: true, progress: 0 });
    try {
      await saveMedia(wx, {
        projectId: this.projectId, index: this.index, media: this.data.media,
        onProgress: progress => this.setData({ progress })
      });
      wx.showToast({ title: "已保存到手机相册", icon: "success", duration: 2200 });
    } catch (error) {
      wx.showModal({ title: "未能保存", content: error.message || "请稍后再试。", showCancel: false });
    } finally {
      this.setData({ busy: false, progress: 0 });
    }
  },
  onBack() {
    wx.redirectTo({ url: this.projectId ? albumPath(this.projectId) : "/pages/entry/index" });
  },
  onPrevious() { this.goTo(this.index - 1); },
  onNext() { this.goTo(this.index + 1); },
  goTo(index) {
    if (index < 0 || index >= this.data.count) return;
    wx.redirectTo({ url: mediaPath(this.projectId, index) });
  },
  onShareAppMessage() {
    return { title: `${this.data.name}｜${this.data.project && this.data.project.title || "活动相册"}`, path: mediaPath(this.projectId, this.index) };
  }
});
