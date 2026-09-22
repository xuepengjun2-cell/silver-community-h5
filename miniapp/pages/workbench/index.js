const { api, getSession, logout, clearSession } = require("../../utils/auth");
const { albumPath } = require("../../utils/album");

Page({
  data: {
    loading: true, busy: false, error: "", user: null, tab: "projects",
    projects: [], activities: [], cases: [], creating: false,
    title: "", dateLabel: "", city: "", description: ""
  },
  onShow() { this.load(); },
  async load() {
    const session = getSession(wx);
    if (!session) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ loading: true, error: "", user: session.user });
    try {
      const [mine, activities, cases] = await Promise.all([
        api(wx, "/my/activity-projects", { token: session.token }),
        api(wx, "/public/activities", { token: session.token }),
        api(wx, "/public/cases", { token: session.token })
      ]);
      this.setData({
        projects: mine.projects || [], activities: activities.activities || [],
        cases: cases.cases || [], loading: false
      });
    } catch (error) {
      if (error.statusCode === 401) {
        clearSession(wx);
        return wx.redirectTo({ url: "/pages/login/index" });
      }
      this.setData({ loading: false, error: error.message });
    }
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }); },
  onCreateOpen() { this.setData({ creating: true }); },
  onCreateClose() { this.setData({ creating: false }); },
  onField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  onDate(event) { this.setData({ dateLabel: event.detail.value }); },
  async onCreate() {
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
  onManage(event) { wx.navigateTo({ url: `/pages/manage/index?id=${event.currentTarget.dataset.id}` }); },
  onView(event) { wx.navigateTo({ url: albumPath(event.currentTarget.dataset.id) }); },
  onCatalog(event) {
    const type = event.currentTarget.dataset.type;
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/catalog/index?type=${type}&id=${encodeURIComponent(id)}` });
  },
  async onLogout() {
    try { await logout(wx); }
    catch { wx.showToast({ title: "已退出本机登录", icon: "none" }); }
    wx.redirectTo({ url: "/pages/entry/index" });
  }
});
