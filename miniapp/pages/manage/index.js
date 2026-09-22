const { api, getSession, clearSession } = require("../../utils/auth");
const { parseAlbumOptions, albumPath, displayName, saveEligibility, trustedMediaUrl } = require("../../utils/album");
const { uploadMedia, getVideoJob } = require("../../utils/upload");

Page({
  data: {
    loading: true, error: "", project: null, photos: 0, videos: 0, tiles: [],
    editing: false, title: "", dateLabel: "", city: "", description: "",
    busy: false, progress: "", jobId: ""
  },
  onLoad(options) {
    const parsed = parseAlbumOptions(options);
    if (!parsed) return this.setData({ loading: false, error: "活动编号无效。" });
    this.projectId = parsed.id;
    this.load();
  },
  onShow() { if (this.projectId && !this.data.loading) this.load(); },
  onUnload() { if (this.pollTimer) clearTimeout(this.pollTimer); },
  async load() {
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ loading: true, error: "" });
    try {
      const { project } = await api(wx, `/my/activity-projects/${this.projectId}`, { token: session.token });
      this.showProject(project);
    } catch (error) {
      if (error.statusCode === 401) { clearSession(wx); return wx.redirectTo({ url: "/pages/login/index" }); }
      this.setData({ loading: false, error: error.message });
    }
  },
  showProject(project) {
    const media = project.media || [];
    this.setData({
      project, loading: false, title: project.title, city: project.city || "",
      dateLabel: project.dateLabel || "", description: project.description || "",
      photos: media.filter(m => m.type === "image").length,
      videos: media.filter(m => m.type === "video").length,
      tiles: media.map((m, index) => ({
        index, type: m.type, url: m.url, label: displayName(m, index),
        poster: trustedMediaUrl({ type: "image", url: m.poster }),
        ready: saveEligibility(m).ok
      }))
    });
  },
  onEdit() { this.setData({ editing: !this.data.editing }); },
  onField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  onDate(event) { this.setData({ dateLabel: event.detail.value }); },
  async onSave() {
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ busy: true });
    try {
      const { project } = await api(wx, `/my/activity-projects/${this.projectId}`, {
        method: "PATCH", token: session.token,
        data: { title: this.data.title.trim(), city: this.data.city.trim(), dateLabel: this.data.dateLabel, description: this.data.description.trim() }
      });
      this.showProject(project);
      this.setData({ editing: false });
    } catch (error) { wx.showModal({ title: "保存失败", content: error.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  async choose(type) {
    if (this.data.busy) return;
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({
        count: type === "image" ? 9 : 1,
        mediaType: [type], sourceType: ["album", "camera"],
        success: resolve, fail: reject
      }));
      const session = getSession(wx);
      if (!session) return wx.redirectTo({ url: "/pages/login/index" });
      this.setData({ busy: true });
      for (let i = 0; i < result.tempFiles.length; i++) {
        this.setData({ progress: `处理第 ${i + 1}/${result.tempFiles.length} 个${type === "image" ? "照片" : "视频"}…` });
        const uploaded = await uploadMedia(wx, {
          projectId: this.projectId, source: result.tempFiles[i].tempFilePath,
          type, token: session.token,
          onProgress: percent => this.setData({ progress: `上传中 ${percent}%` })
        });
        if (type === "video") {
          this.setData({ jobId: uploaded.jobId, progress: "已上传，后台正在调整格式并压缩 MP4…" });
          this.pollJob(uploaded.jobId);
        } else if (uploaded.project) this.showProject(uploaded.project);
      }
      if (type === "image") wx.showToast({ title: "照片已上传", icon: "success" });
    } catch (error) {
      if (!/cancel/i.test(error.errMsg || "")) wx.showModal({ title: "上传未完成", content: error.message || "请稍后重试。", showCancel: false });
      this.setData({ progress: "" });
    } finally { this.setData({ busy: false }); }
  },
  onPhoto() { this.choose("image"); },
  onVideo() { this.choose("video"); },
  async pollJob(jobId) {
    if (!this.projectId) return;
    try {
      const session = getSession(wx);
      if (!session) return;
      const result = await getVideoJob(wx, { projectId: this.projectId, jobId, token: session.token });
      if (result.status === "ready") {
        this.setData({ progress: "视频交付版已生成，可以分享给客户。", jobId: "" });
        this.load();
        return;
      }
      if (result.status === "failed") {
        this.setData({ progress: `视频未发布：${result.error || "处理失败"}`, jobId: "" });
        return;
      }
      this.pollTimer = setTimeout(() => this.pollJob(jobId), 3000);
    } catch (error) { this.setData({ progress: `检查处理状态失败：${error.message}` }); }
  },
  onView() { wx.navigateTo({ url: albumPath(this.projectId) }); },
  onPreview(event) {
    if (this.data.project.shareEnabled && this.data.project.status === "published") {
      wx.navigateTo({ url: albumPath(this.projectId, Number(event.currentTarget.dataset.index)) });
    }
  },
  onDelete(event) {
    const index = Number(event.currentTarget.dataset.index);
    wx.showModal({ title: "从相册移除素材？", content: "移除后客户将看不到它；不会删除云端历史原件。", success: async result => {
      if (!result.confirm) return;
      try {
        const session = getSession(wx);
        const { project } = await api(wx, `/my/activity-projects/${this.projectId}/media/${index}`, { method: "DELETE", token: session.token });
        this.showProject(project);
      } catch (error) { wx.showModal({ title: "移除失败", content: error.message, showCancel: false }); }
    } });
  },
  onShareAppMessage() {
    const project = this.data.project;
    return { title: `${project && project.title || "活动相册"}｜活动回忆`, path: albumPath(this.projectId) };
  }
});
