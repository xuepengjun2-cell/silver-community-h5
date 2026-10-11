const { api, getSession, isSessionCurrent, clearSession } = require("../../utils/auth");
const { parseAlbumOptions, albumPath, displayName, saveEligibility, videoPosterSources } = require("../../utils/album");
const { uploadMedia, getVideoJob, retryVideoJob } = require("../../utils/upload");
const { privacyErrorMessage } = require("../../utils/errors");
const JOB_ID = /^miniapp_[a-f0-9]{24}$/;

Page({
  data: {
    loading: true, error: "", project: null, photos: 0, videos: 0, tiles: [],
    editing: false, title: "", dateLabel: "", city: "", description: "",
    busy: false, progress: "", jobId: "", jobStatus: "", retrying: false, playingIndex: -1
  },
  onLoad(options) {
    const parsed = parseAlbumOptions(options);
    if (!parsed) return this.setData({ loading: false, error: "活动编号无效。" });
    this.destroyed = false;
    this.pageActive = true;
    this.projectId = parsed.id;
    this.load();
  },
  onShow() {
    if (this.destroyed) return;
    this.pageActive = true;
    if (this.projectId && (!this.data.loading || !isSessionCurrent(wx, this.loadingSession))) this.load();
    this.resumeVideoJob(true);
  },
  onHide() { this.pageActive = false; this.stopVideoPolling(); },
  onUnload() { this.destroyed = true; this.pageActive = false; this.stopVideoPolling(); },
  videoJobKey(session) {
    return session && session.user.id && this.projectId
      ? `silver.video-job.v1.${encodeURIComponent(session.user.id)}.${this.projectId}` : "";
  },
  sessionCurrent(session) { return !this.destroyed && isSessionCurrent(wx, session); },
  stopVideoPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollInFlight = null;
    this.pollEpoch = (this.pollEpoch || 0) + 1;
  },
  syncShareMenu() {
    if (this.destroyed) return;
    const method = this.data.busy || this.data.jobId ? "hideShareMenu" : "showShareMenu";
    if (typeof wx[method] === "function") wx[method]({ menus: ["shareAppMessage"] });
  },
  restoreVideoJob(session) {
    const key = this.videoJobKey(session);
    if (this.videoScope !== key || this.videoSessionToken !== (session && session.token)) {
      this.stopVideoPolling();
      this.videoScope = key;
      this.videoSessionToken = session && session.token;
      this.uploadEpoch = (this.uploadEpoch || 0) + 1;
      this.retryEpoch = (this.retryEpoch || 0) + 1;
      this.selecting = false;
      this.setData({ busy: false, jobId: "", jobStatus: "", retrying: false, progress: "" });
    }
    const saved = key && wx.getStorageSync(key);
    if (!saved || !JOB_ID.test(saved.jobId || "")) { this.syncShareMenu(); return; }
    const status = saved.status === "failed" ? "failed" : "processing";
    this.setData({ jobId: saved.jobId, jobStatus: status,
      progress: status === "failed" ? `视频未发布：${saved.error || "处理失败，请重试"}` : "视频已上传，后台正在校验并生成小于 200 MB 的 MP4，请等待完成。" });
    this.syncShareMenu();
  },
  rememberVideoJob(session, jobId, status, error = "") {
    const key = this.videoJobKey(session);
    if (key) wx.setStorageSync(key, { jobId, status, error });
  },
  resumeVideoJob(checkFailed = false) {
    if (!this.projectId || this.destroyed || this.pageActive === false) return;
    const session = getSession(wx);
    if (!session) return;
    this.restoreVideoJob(session);
    if (this.data.retrying) return;
    if (this.data.jobId && (checkFailed || this.data.jobStatus !== "failed") && !this.pollTimer && !this.pollInFlight) this.pollJob(this.data.jobId);
  },
  async load() {
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.loadingSession = session;
    this.resumeVideoJob();
    this.setData({ loading: true, error: "" });
    try {
      const { project } = await api(wx, `/my/activity-projects/${this.projectId}`, { token: session.token });
      if (!this.sessionCurrent(session)) return;
      this.showProject(project);
    } catch (error) {
      if (!this.sessionCurrent(session)) return;
      if (error.statusCode === 401) { clearSession(wx); return wx.redirectTo({ url: "/pages/login/index" }); }
      this.setData({ loading: false, error: error.message });
    }
  },
  showProject(project) {
    const media = project.media || [];
    this.setData({
      project, loading: false, title: project.title, city: project.city || "",
      dateLabel: project.dateLabel || "", description: project.description || "",
      playingIndex: -1,
      photos: media.filter(m => m.type === "image").length,
      videos: media.filter(m => m.type === "video").length,
      tiles: media.map((m, index) => ({
        index, type: m.type, url: m.url, label: displayName(m, index),
        ...videoPosterSources(m),
        ready: saveEligibility(m).ok
      }))
    });
  },
  onEdit() { if (this.data.project && this.data.project.canManage) this.setData({ editing: !this.data.editing }); },
  onPosterError(event) {
    const { index, url } = event.currentTarget.dataset;
    const tile = this.data.tiles.find(item => item.index === Number(index));
    if (!tile || tile.type !== "video" || tile.poster !== url) return;
    this.setData({ tiles: this.data.tiles.map(item => item.index === tile.index
      ? { ...item, poster: item.fallbackPoster || "", fallbackPoster: "" } : item) });
  },
  onField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  onDate(event) { this.setData({ dateLabel: event.detail.value }); },
  async onSave() {
    if (this.data.busy || !this.data.project || !this.data.project.canManage) return;
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
    if (this.destroyed || this.selecting || this.data.busy || this.data.retrying || !this.data.project || !this.data.project.canManage) return;
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.restoreVideoJob(session);
    if (type === "video" && this.data.jobId && this.data.jobStatus !== "failed") return wx.showToast({ title: "上一段视频仍在后台处理，请等待完成。", icon: "none" });
    this.selecting = true;
    const epoch = this.uploadEpoch = (this.uploadEpoch || 0) + 1;
    const current = () => this.sessionCurrent(session) && this.uploadEpoch === epoch;
    this.setData({ busy: true });
    this.syncShareMenu();
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({
        count: type === "image" ? 9 : 1,
        mediaType: [type], sourceType: ["album", "camera"],
        // 相机拍摄默认最长 10 秒，60 秒是微信允许的上限；从相册选择不受此限制。
        maxDuration: 60,
        success: resolve, fail: reject
      }));
      if (!current()) return;
      const scope = this.videoJobKey(session);
      for (let i = 0; i < result.tempFiles.length; i++) {
        if (!current()) return;
        this.setData({ progress: `处理第 ${i + 1}/${result.tempFiles.length} 个${type === "image" ? "照片" : "视频"}…` });
        const uploaded = await uploadMedia(wx, {
          projectId: this.projectId, source: result.tempFiles[i].tempFilePath,
          type, token: session.token,
          isCancelled: () => !current(),
          onStage: stage => { if (current()) this.setData({ progress: stage === "preparing" ? `${type === "video" ? "正在手机上压缩视频" : "正在压缩照片"}，请保持页面打开…` : "正在上传压缩后的素材，请保持页面打开…" }); },
          onProgress: percent => { if (current()) this.setData({ progress: `上传中 ${percent}%` }); }
        });
        if (type === "video") {
          // 即使上传响应在页面离开后到达，也保存任务，返回时继续查询，避免重复传原片。
          this.rememberVideoJob(session, uploaded.jobId, "processing");
          if (current()) {
            this.stopVideoPolling();
            this.videoScope = scope;
            this.setData({ jobId: uploaded.jobId, jobStatus: "processing", progress: "已上传，后台正在生成并校验 MP4；处理完成前请勿分享。" });
            this.resumeVideoJob();
          }
        } else if (current() && uploaded.project) this.showProject(uploaded.project);
      }
      if (current() && type === "image") wx.showToast({ title: "照片已上传", icon: "success" });
    } catch (error) {
      if (!current()) return;
      if (!/cancel/i.test(error.errMsg || "")) wx.showModal({ title: "上传未完成", content: privacyErrorMessage(error) || error.message || "请稍后重试。", showCancel: false });
      if (this.data.jobId) this.restoreVideoJob(getSession(wx));
      else this.setData({ progress: "" });
    } finally {
      if (this.uploadEpoch === epoch) this.selecting = false;
      if (current()) {
        this.setData({ busy: false });
        if (type === "image" && this.data.jobId) this.restoreVideoJob(getSession(wx));
        this.syncShareMenu();
      }
    }
  },
  onPhoto() { this.choose("image"); },
  onVideo() { this.choose("video"); },
  async pollJob(jobId, epoch = this.pollEpoch || 0) {
    if (!this.projectId || this.destroyed || this.pageActive === false || this.data.jobId !== jobId || this.pollInFlight) return;
    const session = getSession(wx), scope = this.videoJobKey(session);
    if (!session || scope !== this.videoScope) return;
    const current = () => this.sessionCurrent(session) && this.pageActive !== false && epoch === (this.pollEpoch || 0) && this.data.jobId === jobId && this.videoScope === scope;
    const schedule = delay => { this.pollTimer = setTimeout(() => { this.pollTimer = null; this.pollJob(jobId, epoch); }, delay); };
    this.pollInFlight = { epoch, jobId };
    try {
      const result = await getVideoJob(wx, { projectId: this.projectId, jobId, token: session.token });
      if (!current()) return;
      this.pollFailures = 0;
      if (result.status === "ready") {
        const saved = scope && wx.getStorageSync(scope);
        if (saved && saved.jobId === jobId) wx.removeStorageSync(scope);
        this.setData({ progress: "视频交付版已生成，可以分享给客户。", jobId: "", jobStatus: "" });
        this.syncShareMenu();
        this.load();
        return;
      }
      if (result.status === "failed") {
        this.rememberVideoJob(session, jobId, "failed", result.error);
        this.setData({ progress: `视频未发布：${result.error || "处理失败"}`, jobStatus: "failed" });
        return;
      }
      this.rememberVideoJob(session, jobId, "processing");
      this.setData({ jobStatus: "processing", progress: result.status === "queued" ? "视频正在后台排队，完成校验后才能分享。" : "后台正在生成并校验小于 200 MB 的 MP4，请等待完成。" });
      schedule(3000);
    } catch (error) {
      if (!current()) return;
      if (error.statusCode === 401) {
        clearSession(wx);
        wx.redirectTo({ url: "/pages/login/index" });
        return;
      }
      if ([403, 404].includes(error.statusCode)) {
        this.rememberVideoJob(session, jobId, "failed", error.message);
        this.setData({ progress: `无法访问视频任务：${error.message}，请重新登录或联系管理员。`, jobStatus: "failed" });
        return;
      }
      this.pollFailures = (this.pollFailures || 0) + 1;
      const delay = Math.min(30000, 3000 * 2 ** Math.min(this.pollFailures - 1, 4));
      this.setData({ progress: `暂时无法查询处理状态，将自动重试：${error.message}` });
      schedule(delay);
    } finally {
      if (this.pollInFlight && this.pollInFlight.epoch === epoch && this.pollInFlight.jobId === jobId) this.pollInFlight = null;
    }
  },
  async onRetryVideo() {
    if (this.destroyed || this.data.busy || this.data.retrying || !this.data.jobId || this.data.jobStatus !== "failed") return;
    const session = getSession(wx), jobId = this.data.jobId, scope = this.videoJobKey(session);
    if (!session || scope !== this.videoScope) return;
    const epoch = this.retryEpoch = (this.retryEpoch || 0) + 1;
    const current = () => this.sessionCurrent(session) && this.retryEpoch === epoch && this.data.jobId === jobId;
    this.setData({ retrying: true });
    this.stopVideoPolling();
    try {
      await retryVideoJob(wx, { projectId: this.projectId, jobId, token: session.token });
      const saved = scope && wx.getStorageSync(scope);
      if (saved && saved.jobId === jobId) this.rememberVideoJob(session, jobId, "processing");
      if (!current()) return;
      this.setData({ jobStatus: "processing", progress: "已重新排队，复用已上传的视频，无需再次上传。" });
    } catch (error) {
      if (current()) {
        this.rememberVideoJob(session, jobId, "failed", error.message);
        this.setData({ progress: `视频未发布：${error.message}` });
      }
    } finally {
      if (current()) {
        this.setData({ retrying: false });
        if (this.data.jobStatus !== "failed") this.resumeVideoJob();
      }
    }
  },
  onDiscardVideo() {
    if (this.destroyed || this.data.busy || this.data.retrying || !this.data.jobId || this.data.jobStatus !== "failed") return;
    const session = getSession(wx), jobId = this.data.jobId, scope = this.videoJobKey(session);
    if (!this.sessionCurrent(session) || scope !== this.videoScope) return;
    wx.showModal({ title: "放弃本次失败视频？", content: "仅清除此设备的失败任务记录，不删除已发布的照片和视频。放弃后可以分享相册中已有的内容。", confirmText: "放弃本次", success: result => {
      if (!result.confirm || !this.sessionCurrent(session) || this.data.jobId !== jobId || this.data.jobStatus !== "failed" || this.data.busy || this.data.retrying) return;
      const saved = scope && wx.getStorageSync(scope);
      if (saved && saved.jobId === jobId) wx.removeStorageSync(scope);
      this.stopVideoPolling();
      this.retryEpoch = (this.retryEpoch || 0) + 1;
      this.setData({ jobId: "", jobStatus: "", progress: "已放弃本次失败视频，可以分享相册中已发布的内容。" });
      this.syncShareMenu();
    } });
  },
  onView() {
    if (this.data.busy || this.data.jobId) return wx.showToast({ title: "素材处理完成后再预览分享。", icon: "none" });
    wx.navigateTo({ url: albumPath(this.projectId) });
  },
  onPreview(event) {
    const index = Number(event.currentTarget.dataset.index);
    const media = (this.data.project.media || [])[index];
    if (!media) return;
    if (media.type === "image") {
      const urls = this.data.project.media.filter(item => item.type === "image").map(item => item.url);
      wx.previewImage({ current: media.url, urls });
    } else if (media.type === "video") this.setData({ playingIndex: index });
  },
  onDelete(event) {
    if (!this.data.project || !this.data.project.canManage) return;
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
  onProjectDelete() {
    if (!this.data.project || !this.data.project.canManage || this.data.busy) return;
    wx.showModal({ title: "删除整个活动相册？", content: "确认后相册分享链接将失效；云端历史文件暂不删除。", confirmText: "删除相册", confirmColor: "#c83e31", success: async result => {
      if (!result.confirm) return;
      const session = getSession(wx);
      if (!session) return wx.redirectTo({ url: "/pages/login/index" });
      this.setData({ busy: true });
      try {
        await api(wx, `/my/activity-projects/${this.projectId}`, { method: "DELETE", token: session.token });
        wx.redirectTo({ url: "/pages/workbench/index" });
      } catch (error) { wx.showModal({ title: "删除失败", content: error.message, showCancel: false }); }
      finally { this.setData({ busy: false }); }
    } });
  },
  onShareAppMessage() {
    const project = this.data.project;
    return { title: `${project && project.title || "活动相册"}｜活动回忆`, path: albumPath(this.projectId) };
  }
});
