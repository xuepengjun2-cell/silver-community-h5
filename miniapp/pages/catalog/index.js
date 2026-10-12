const { api, getSession } = require("../../utils/auth");
const { catalogPath, catalogCover, sharePayload, caseMedia, activityMedia, catalogItemView, photoUrl } = require("../../utils/catalog");
const { openSopPdf, saveCaseMedia, openCaseDocument } = require("../../utils/catalog-download");
const { loginPath } = require("../../utils/navigation");

const CASE_GROUPS = [
  { key: "image", label: "照片" },
  { key: "document", label: "文档" }
];
const PAGE_SIZE = 12;

function sections(plan) {
  return [
    { key: "target", title: "活动定位", icon: "🎯" },
    { key: "materials", title: "所需物料", icon: "📦" },
    { key: "staffing", title: "人员分工", icon: "👥" },
    { key: "conversion", title: "话术与转化承接", icon: "🔄" },
    { key: "risk", title: "注意事项与风险预案", icon: "⚠️" }
  ].filter(section => plan && plan[section.key]).map(section => ({ ...section, content: plan[section.key] }));
}

Page({
  data: {
    loading: true, error: "", item: null, type: "", cover: "", media: [],
    mediaTabs: [], activeTab: "", shownMedia: [], hasMore: false,
    highlights: [], schedule: [], planSections: [], facts: [], activityImages: [],
    loggedIn: false, canDownloadSop: false, pdfBusy: false, savingIndex: -1, downloadProgress: 0
  },
  onLoad(options) {
    try { catalogPath(options.type, options.id); }
    catch { return this.setData({ loading: false, error: "内容编号无效。" }); }
    this.type = options.type;
    this.id = options.id;
    this.guestMode = options.guest === "1";
    this.load();
  },
  onShow() {
    const session = this.guestMode ? null : getSession(wx);
    this.setData({ loggedIn: Boolean(session), canDownloadSop: Boolean(session && session.user.canDownload !== false) });
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const session = this.guestMode ? null : getSession(wx);
      const result = await api(wx, `/public/${this.type}/${encodeURIComponent(this.id)}`, { token: session && session.token });
      const original = result.activity || result.case;
      if (!original) throw new Error("该内容暂时无法查看。");
      const item = catalogItemView(original, this.type);
      wx.setNavigationBarTitle({ title: item.title || "活动详情" });
      const media = this.type === "cases" ? caseMedia(original) : activityMedia(original);
      const tabs = CASE_GROUPS.map(group => ({ ...group, count: media.filter(entry => entry.type === group.key).length }))
        .filter(group => group.count > 0);
      const activeTab = tabs[0] && tabs[0].key || "";
      const cover = catalogCover(item, this.type);
      this.shareItem = item;
      this.allMedia = media;
      this.setData({
        loading: false, type: this.type, item, cover, media,
        mediaTabs: tabs, activeTab, shownMedia: media.filter(entry => entry.type === activeTab).slice(0, PAGE_SIZE),
        hasMore: media.filter(entry => entry.type === activeTab).length > PAGE_SIZE,
        highlights: item.highlights || [], schedule: item.schedule || [],
        planSections: item.planLocked ? [] : sections(item.plan || {}),
        facts: [
          { label: "参考价格", value: item.price || "咨询主理人" },
          { label: "适合人数", value: item.capacity || "待确认" },
          { label: "活动时长", value: item.duration || "待确认" },
          { label: "推荐地点", value: item.location || "同城场地" }
        ],
        activityImages: media.filter(entry => entry.type === "image"),
        loggedIn: Boolean(session), canDownloadSop: Boolean(session && session.user.canDownload !== false)
      });
    } catch (error) { this.setData({ loading: false, error: error.message || "加载失败" }); }
  },
  onTab(event) {
    const activeTab = event.currentTarget.dataset.tab;
    if (!CASE_GROUPS.some(group => group.key === activeTab)) return;
    const subset = this.allMedia.filter(entry => entry.type === activeTab);
    this.setData({ activeTab, shownMedia: subset.slice(0, PAGE_SIZE), hasMore: subset.length > PAGE_SIZE });
  },
  onMore() {
    const subset = this.allMedia.filter(entry => entry.type === this.data.activeTab);
    const count = this.data.shownMedia.length + PAGE_SIZE;
    this.setData({ shownMedia: subset.slice(0, count), hasMore: subset.length > count });
  },
  onImage(event) {
    const current = event.currentTarget.dataset.url;
    const images = (this.allMedia || []).filter(entry => entry.type === "image").map(entry => photoUrl(entry.url)).filter(Boolean);
    // 案例保存统一经过 onCaseSave 的服务端鉴权和审计，原生菜单不能绕过。
    if (images.includes(current)) wx.previewImage({ current, urls: images, showmenu: this.type !== "cases" });
  },
  onDownloadError(error) {
    const message = error && error.message || "下载失败，请稍后重试。";
    if (/登录/.test(message) || error && error.statusCode === 401) {
      wx.showModal({
        title: "需要登录",
        content: message,
        confirmText: "去登录",
        success: result => { if (result.confirm) this.onLogin(); }
      });
    } else wx.showModal({ title: "未能完成下载", content: message, showCancel: false });
  },
  async onSopPdf() {
    if (this.data.pdfBusy || !this.data.item) return;
    if (!this.data.loggedIn) return this.onDownloadError(new Error("请先登录平台账号，再按账号权限下载活动方案。"));
    if (this.data.loggedIn && !this.data.canDownloadSop) {
      return wx.showModal({ title: "无下载权限", content: "请联系总部开通 SOP 下载权限。", showCancel: false });
    }
    this.setData({ pdfBusy: true, downloadProgress: 0 });
    try {
      await openSopPdf(wx, this.id, progress => this.setData({ downloadProgress: progress }));
    } catch (error) { this.onDownloadError(error); }
    finally { this.setData({ pdfBusy: false, downloadProgress: 0 }); }
  },
  async onCaseSave(event) {
    if (this.data.savingIndex !== -1) return;
    if (!this.data.loggedIn) return this.onDownloadError(new Error("请先登录平台账号，再下载精彩案例素材。"));
    const index = Number(event.currentTarget.dataset.index);
    const media = this.allMedia && this.allMedia.find(entry => entry.index === index);
    if (!media || media.type !== "image") return;
    this.setData({ savingIndex: index, downloadProgress: 0 });
    try {
      await saveCaseMedia(wx, this.id, media, progress => this.setData({ downloadProgress: progress }));
      wx.showToast({ title: "已保存到手机相册", icon: "success", duration: 2200 });
    } catch (error) { this.onDownloadError(error); }
    finally { this.setData({ savingIndex: -1, downloadProgress: 0 }); }
  },
  async onCaseDocument(event) {
    if (this.data.savingIndex !== -1) return;
    if (!this.data.loggedIn) return this.onDownloadError(new Error("请先登录平台账号，再下载精彩案例文档。"));
    const index = Number(event.currentTarget.dataset.index);
    const media = this.allMedia && this.allMedia.find(entry => entry.index === index);
    if (!media || media.type !== "document") return;
    this.setData({ savingIndex: index, downloadProgress: 0 });
    try { await openCaseDocument(wx, this.id, media, progress => this.setData({ downloadProgress: progress })); }
    catch (error) { this.onDownloadError(error); }
    finally { this.setData({ savingIndex: -1, downloadProgress: 0 }); }
  },
  onLogin() { wx.navigateTo({ url: loginPath(catalogPath(this.type, this.id)) }); },
  onShareAppMessage() { return sharePayload(this.shareItem || this.data.item || { id: this.id }, this.type); }
});
