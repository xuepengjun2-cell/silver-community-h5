const { getProject } = require("../../utils/api");
const { saveMedia } = require("../../utils/save");
const { apiBase } = require("../../config");
const { parseAlbumOptions, albumPath, mediaPath, saveEligibility, displayName, trustedMediaUrl } = require("../../utils/album");

Page({
  data: {
    loading: true, error: "", project: null, media: null, index: 0, position: 0,
    name: "", count: 0, previousIndex: -1, nextIndex: -1,
    canSave: false, reason: "", busy: false, progress: 0
  },
  onLoad(options) {
    const parsed = parseAlbumOptions(options);
    if (!parsed || parsed.index === null) {
      return this.setData({ loading: false, error: "素材链接无效，请返回照片相册。" });
    }
    this.projectId = parsed.id;
    this.index = parsed.index;
    this.loadMedia();
  },
  onShow() {
    // 客户从单照片分享卡片进入时，同样不显示通往主办方登录页的“返回首页”。
    if (typeof wx.hideHomeButton === "function") wx.hideHomeButton();
  },
  async loadMedia() {
    this.photoIndices = [];
    this.setData({ loading: true, error: "", project: null, media: null, canSave: false, count: 0, position: 0, previousIndex: -1, nextIndex: -1 });
    try {
      const source = await getProject(wx, this.projectId);
      const allMedia = Array.isArray(source.media) ? source.media : [];
      const original = allMedia[this.index];
      if (!trustedMediaUrl(original)) throw new Error("这个素材在本小程序中不可用，请返回照片相册。");
      const eligibility = saveEligibility(original);
      this.photoIndices = allMedia.map((item, index) => trustedMediaUrl(item) ? index : -1).filter(index => index >= 0);
      const position = this.photoIndices.indexOf(this.index);
      const project = { id: source.id, title: String(source.title || "") };
      const media = {
        type: "image", url: trustedMediaUrl(original), title: String(original.title || ""), size: Number(original.size) || 0
      };
      wx.setNavigationBarTitle({ title: "保存活动照片" });
      this.setData({
        loading: false, project, media, index: this.index, position: position + 1, count: this.photoIndices.length,
        previousIndex: position > 0 ? this.photoIndices[position - 1] : -1,
        nextIndex: position + 1 < this.photoIndices.length ? this.photoIndices[position + 1] : -1,
        name: displayName(original, this.index), canSave: eligibility.ok, reason: eligibility.reason
      });
      this.recordView();
    } catch (error) {
      this.setData({ loading: false, error: error.message || "照片暂时无法打开。" });
    }
  },
  recordView() {
    if (!trustedMediaUrl(this.data.media) || this.viewedIndex === this.index) return;
    this.viewedIndex = this.index;
    // 观看统计属于辅助信息；不能因此影响游客看照片或保存。
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
  onPrevious() { this.goTo(this.data.previousIndex); },
  onNext() { this.goTo(this.data.nextIndex); },
  goTo(index) {
    if (this.data.busy || !Number.isSafeInteger(index) || !(this.photoIndices || []).includes(index)) return;
    wx.redirectTo({ url: mediaPath(this.projectId, index) });
  },
  onShareAppMessage() {
    if (!this.data.media) {
      return { title: "照片相册", path: this.projectId ? albumPath(this.projectId) : "/pages/entry/index" };
    }
    return { title: `${this.data.name}｜${this.data.project.title || "照片相册"}`, path: mediaPath(this.projectId, this.index) };
  }
});
