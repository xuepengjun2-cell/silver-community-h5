const { api, getSession, validateSession, logout, clearSession } = require("../../utils/auth");
const { albumPath } = require("../../utils/album");
const { cardView, catalogPath, sharePayload, filterCatalogCards } = require("../../utils/catalog");

Page({
  data: {
    loading: true, busy: false, error: "", user: null, tab: "projects", canCreateProjects: false,
    projects: [], activities: [], visibleActivities: [], activityQuery: "", cases: [], creating: false,
    title: "", dateLabel: "", city: "", description: ""
  },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const session = await validateSession(wx);
      if (!session) return wx.redirectTo({ url: "/pages/entry/index" });
      this.setData({ user: session.user });
      const [mine, activities, cases] = await Promise.all([
        api(wx, "/my/activity-projects", { token: session.token }),
        api(wx, "/public/activities", { token: session.token }),
        api(wx, "/public/cases", { token: session.token })
      ]);
      const activityCards = (activities.activities || []).map(item => cardView(item, "activities"));
      this.setData({
        projects: mine.projects || [],
        canCreateProjects: mine.canCreate === true,
        activities: activityCards,
        visibleActivities: filterCatalogCards(activityCards, this.data.activityQuery),
        cases: (cases.cases || []).map(item => cardView(item, "cases")),
        loading: false
      });
    } catch (error) {
      if (error.statusCode === 401) {
        clearSession(wx);
        return wx.redirectTo({ url: "/pages/entry/index" });
      }
      this.setData({ loading: false, error: error.message });
    }
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onTab(event) {
    const tab = event.currentTarget.dataset.tab;
    this.setData({ tab });
  },
  onActivitySearch(event) {
    const activityQuery = event.detail.value;
    this.setData({ activityQuery, visibleActivities: filterCatalogCards(this.data.activities, activityQuery) });
  },
  onActivityClear() {
    this.setData({ activityQuery: "", visibleActivities: this.data.activities });
  },
  onCreateOpen() { if (this.data.canCreateProjects) this.setData({ creating: true }); },
  onCreateClose() { this.setData({ creating: false }); },
  onField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  onDate(event) { this.setData({ dateLabel: event.detail.value }); },
  async onCreate() {
    if (!this.data.canCreateProjects) return;
    if (this.data.busy) return;
    const title = this.data.title.trim();
    if (!title) return wx.showToast({ title: "请填写活动名称", icon: "none" });
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ busy: true });
    try {
      const { project } = await api(wx, "/my/activity-projects", {
        method: "POST", token: session.token,
        data: { title, dateLabel: this.data.dateLabel, city: this.data.city.trim(), description: this.data.description.trim() }
      });
      this.setData({ creating: false, title: "", dateLabel: "", city: "", description: "" });
      wx.navigateTo({ url: `/pages/manage/index?id=${project.id}` });
    } catch (error) { wx.showModal({ title: "创建失败", content: error.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  onManage(event) {
    wx.navigateTo({ url: `/pages/manage/index?id=${event.currentTarget.dataset.id}` });
  },
  onView(event) {
    wx.navigateTo({ url: albumPath(event.currentTarget.dataset.id) });
  },
  onCatalog(event) {
    const type = event.currentTarget.dataset.type;
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: catalogPath(type, id) });
  },
  onShareAppMessage(options) {
    const dataset = options.target && options.target.dataset || {};
    const type = dataset.type;
    const item = type === "cases"
      ? this.data.cases.find(row => row.id === dataset.id)
      : this.data.activities.find(row => row.id === dataset.id);
    if (item && ["cases", "activities"].includes(type)) return sharePayload(item, type);
    return { title: "开开华彩活动工作台", path: "/pages/entry/index" };
  },
  async onLogout() {
    try { await logout(wx); }
    catch { wx.showToast({ title: "已退出本机登录", icon: "none" }); }
    wx.redirectTo({ url: "/pages/entry/index" });
  }
});
