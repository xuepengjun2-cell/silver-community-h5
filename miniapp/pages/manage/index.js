const { api, getSession, isSessionCurrent, clearSession } = require("../../utils/auth");
const { parseAlbumOptions, albumPath, displayName, saveEligibility, trustedMediaUrl } = require("../../utils/album");
const { uploadMedia, isImageSelection } = require("../../utils/upload");
const { privacyErrorMessage } = require("../../utils/errors");

Page({
  data: {
    loading: true, error: "", project: null, photos: 0, tiles: [],
    editing: false, title: "", dateLabel: "", city: "", description: "",
    busy: false, progress: ""
  },
  onLoad(options) {
    const parsed = parseAlbumOptions(options);
    if (!parsed) return this.setData({ loading: false, error: "活动编号无效。" });
    this.destroyed = false;
    this.projectId = parsed.id;
    this.load();
  },
  onShow() {
    if (this.destroyed) return;
    const session = getSession(wx);
    this.syncSession(session);
    if (this.projectId && !this.data.busy && (!this.data.loading || !isSessionCurrent(wx, this.loadingSession))) this.load();
  },
  onUnload() {
    this.destroyed = true;
    this.uploadEpoch = (this.uploadEpoch || 0) + 1;
    this.loadEpoch = (this.loadEpoch || 0) + 1;
  },
  sessionCurrent(session) { return !this.destroyed && isSessionCurrent(wx, session); },
  syncSession(session) {
    const scope = session ? `${session.user.id || ""}:${session.token}` : "";
    if (this.sessionScope === scope) return;
    this.sessionScope = scope;
    this.uploadEpoch = (this.uploadEpoch || 0) + 1;
    this.loadEpoch = (this.loadEpoch || 0) + 1;
    this.selecting = false;
    this.setData({ busy: false, progress: "", project: null, tiles: [], photos: 0, editing: false });
    this.syncShareMenu();
  },
  syncShareMenu() {
    if (this.destroyed) return;
    const method = this.data.busy ? "hideShareMenu" : "showShareMenu";
    if (typeof wx[method] === "function") wx[method]({ menus: ["shareAppMessage"] });
  },
  async load() {
    const session = getSession(wx);
    this.syncSession(session);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.loadingSession = session;
    const epoch = this.loadEpoch = (this.loadEpoch || 0) + 1;
    const current = () => this.sessionCurrent(session) && this.loadEpoch === epoch;
    this.setData({ loading: true, error: "" });
    try {
      const { project } = await api(wx, `/my/activity-projects/${this.projectId}`, { token: session.token });
      if (!current()) return;
      this.showProject(project);
    } catch (error) {
      if (!current()) return;
      if (error.statusCode === 401) { clearSession(wx); return wx.redirectTo({ url: "/pages/login/index" }); }
      this.setData({ loading: false, error: error.message });
    }
  },
  showProject(project) {
    const tiles = (Array.isArray(project.media) ? project.media : []).map((media, index) => {
      const url = media && media.type === "image" ? trustedMediaUrl(media) : "";
      return url ? { index, type: "image", url, label: displayName(media, index), ready: saveEligibility(media).ok } : null;
    }).filter(Boolean);
    // 只将照片与页面使用的资料传入视图，原始下标保留给服务端移除接口。
    const view = {
      id: project.id, title: project.title || "活动相册", city: project.city || "",
      dateLabel: project.dateLabel || "", description: project.description || "",
      canManage: project.canManage === true, status: project.status, shareEnabled: project.shareEnabled === true,
      cover: trustedMediaUrl({ type: "image", url: project.cover }) || (tiles[0] && tiles[0].url) || "",
      media: tiles.map(tile => ({ index: tile.index, type: "image", url: tile.url, title: tile.label }))
    };
    this.setData({
      project: view, loading: false, title: view.title, city: view.city,
      dateLabel: view.dateLabel, description: view.description,
      photos: tiles.length, tiles
    });
  },
  onEdit() { if (!this.data.busy && this.data.project && this.data.project.canManage) this.setData({ editing: !this.data.editing }); },
  onField(event) {
    const field = event.currentTarget.dataset.field;
    if (["title", "city", "description"].includes(field)) this.setData({ [field]: event.detail.value });
  },
  onDate(event) { this.setData({ dateLabel: event.detail.value }); },
  async onSave() {
    if (this.destroyed || this.data.busy || !this.data.project || !this.data.project.canManage) return;
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ busy: true });
    this.syncShareMenu();
    try {
      const { project } = await api(wx, `/my/activity-projects/${this.projectId}`, {
        method: "PATCH", token: session.token,
        data: { title: this.data.title.trim(), city: this.data.city.trim(), dateLabel: this.data.dateLabel, description: this.data.description.trim() }
      });
      if (!this.sessionCurrent(session)) return;
      this.loadEpoch = (this.loadEpoch || 0) + 1;
      this.showProject(project);
      this.setData({ editing: false });
    } catch (error) {
      if (this.sessionCurrent(session)) wx.showModal({ title: "保存失败", content: error.message, showCancel: false });
    } finally {
      if (this.sessionCurrent(session)) { this.setData({ busy: false }); this.syncShareMenu(); }
    }
  },
  async choose(type) {
    // 即使被旧入口或直接调用，也不能开始图片以外的文件选择或网络上传。
    if (type !== "image") throw new Error("本小程序仅支持上传照片。");
    if (this.destroyed || this.selecting || this.data.busy || !this.data.project || !this.data.project.canManage) return;
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.selecting = true;
    const epoch = this.uploadEpoch = (this.uploadEpoch || 0) + 1;
    const current = () => this.sessionCurrent(session) && this.uploadEpoch === epoch;
    this.setData({ busy: true, progress: "" });
    this.syncShareMenu();
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({
        count: 9, mediaType: ["image"], sourceType: ["album", "camera"],
        success: resolve, fail: reject
      }));
      if (!current()) return;
      if (!Array.isArray(result.tempFiles) || !result.tempFiles.length || result.tempFiles.length > 9 || !result.tempFiles.every(isImageSelection)) {
        throw new Error("请选择照片文件，本小程序仅支持上传照片。");
      }
      for (let i = 0; i < result.tempFiles.length; i++) {
        if (!current()) return;
        this.setData({ progress: `处理第 ${i + 1}/${result.tempFiles.length} 张照片…` });
        const uploaded = await uploadMedia(wx, {
          projectId: this.projectId, source: result.tempFiles[i].tempFilePath,
          type: "image", token: session.token,
          isCancelled: () => !current(),
          onStage: stage => { if (current()) this.setData({ progress: stage === "preparing" ? "正在压缩照片，请保持页面打开…" : "正在上传压缩后的照片，请保持页面打开…" }); },
          onProgress: percent => { if (current()) this.setData({ progress: `上传中 ${percent}%` }); }
        });
        if (current() && uploaded.project) {
          this.loadEpoch = (this.loadEpoch || 0) + 1;
          this.showProject(uploaded.project);
        }
      }
      if (current()) { this.setData({ progress: "照片已上传，可以分享相册。" }); wx.showToast({ title: "照片已上传", icon: "success" }); }
    } catch (error) {
      if (!current()) return;
      if (!/cancel/i.test(error.errMsg || "")) wx.showModal({ title: "上传未完成", content: privacyErrorMessage(error) || error.message || "请稍后重试。", showCancel: false });
      this.setData({ progress: "" });
    } finally {
      if (this.uploadEpoch === epoch) this.selecting = false;
      if (current()) { this.setData({ busy: false }); this.syncShareMenu(); }
    }
  },
  onPhoto() { return this.choose("image"); },
  onView() {
    if (this.data.busy) return wx.showToast({ title: "照片上传完成后再预览分享。", icon: "none" });
    wx.navigateTo({ url: albumPath(this.projectId) });
  },
  onPreview(event) {
    const index = Number(event.currentTarget.dataset.index);
    const tile = this.data.tiles.find(item => item.index === index);
    if (!tile) return;
    wx.previewImage({ current: tile.url, urls: this.data.tiles.map(item => item.url), showmenu: false });
  },
  onDelete(event) {
    if (this.destroyed || this.data.busy || !this.data.project || !this.data.project.canManage) return;
    const index = Number(event.currentTarget.dataset.index);
    const tile = this.data.tiles.find(item => item.index === index);
    const session = getSession(wx);
    if (!tile || !session) return;
    wx.showModal({ title: "从相册移除照片？", content: "移除后客户将看不到它；不会删除云端历史原件。", success: async result => {
      if (!result.confirm || !this.sessionCurrent(session) || this.data.busy || !this.data.project || !this.data.project.canManage
        || !this.data.tiles.some(item => item.index === index && item.url === tile.url)) return;
      this.setData({ busy: true });
      this.syncShareMenu();
      try {
        const { project } = await api(wx, `/my/activity-projects/${this.projectId}/media/${index}`, { method: "DELETE", token: session.token });
        if (!this.sessionCurrent(session)) return;
        this.loadEpoch = (this.loadEpoch || 0) + 1;
        this.showProject(project);
      } catch (error) {
        if (this.sessionCurrent(session)) wx.showModal({ title: "移除失败", content: error.message, showCancel: false });
      } finally {
        if (this.sessionCurrent(session)) { this.setData({ busy: false }); this.syncShareMenu(); }
      }
    } });
  },
  onProjectDelete() {
    if (this.destroyed || !this.data.project || !this.data.project.canManage || this.data.busy) return;
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    wx.showModal({ title: "删除整个活动相册？", content: "确认后相册分享链接将失效；云端历史文件暂不删除。", confirmText: "删除相册", confirmColor: "#c83e31", success: async result => {
      if (!result.confirm || !this.sessionCurrent(session) || this.data.busy || !this.data.project || !this.data.project.canManage) return;
      this.setData({ busy: true });
      this.syncShareMenu();
      try {
        await api(wx, `/my/activity-projects/${this.projectId}`, { method: "DELETE", token: session.token });
        if (this.sessionCurrent(session)) wx.redirectTo({ url: "/pages/workbench/index" });
      } catch (error) {
        if (this.sessionCurrent(session)) wx.showModal({ title: "删除失败", content: error.message, showCancel: false });
      } finally {
        if (this.sessionCurrent(session)) { this.setData({ busy: false }); this.syncShareMenu(); }
      }
    } });
  },
  onShareAppMessage() {
    const project = this.data.project;
    return { title: `${project && project.title || "活动相册"}｜活动回忆`, path: albumPath(this.projectId) };
  }
});
