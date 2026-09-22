const { api, getSession } = require("../../utils/auth");
const { mediaUrl } = require("../../utils/urls");
const { catalogPath, catalogCover, sharePayload } = require("../../utils/catalog");

const CASE_GROUPS = [
  { key: "image", label: "照片" },
  { key: "video", label: "视频" },
  { key: "document", label: "文档" },
  { key: "link", label: "外部链接" }
];
const PAGE_SIZE = 12;

function caseMedia(item) {
  return (item.media || []).map((entry, index) => ({
    ...entry,
    index,
    url: mediaUrl(entry.url),
    title: entry.title || entry.caption || `${{ image: "照片", video: "视频", document: "文档", link: "外部素材" }[entry.type] || "素材"} ${index + 1}`
  })).filter(entry => entry.url && CASE_GROUPS.some(group => group.key === entry.type));
}

function activityMedia(item) {
  return [
    ...(item.images || []).map((url, index) => ({ type: "image", url: mediaUrl(url), title: `活动照片 ${index + 1}`, index })),
    ...(item.videos || []).map((url, index) => ({ type: "video", url: mediaUrl(url), title: `参考视频 ${index + 1}`, index }))
  ].filter(entry => entry.url);
}

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
    mediaTabs: [], activeTab: "", shownMedia: [], hasMore: false, playingIndex: -1,
    highlights: [], schedule: [], planSections: [], facts: [], activityImages: [], activityVideos: []
  },
  onLoad(options) {
    try { catalogPath(options.type, options.id); }
    catch { return this.setData({ loading: false, error: "内容编号无效。" }); }
    this.type = options.type;
    this.id = options.id;
    this.load();
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const session = getSession(wx);
      const result = await api(wx, `/public/${this.type}/${encodeURIComponent(this.id)}`, { token: session && session.token });
      const item = result.activity || result.case;
      if (!item) throw new Error("该内容暂时无法查看。");
      wx.setNavigationBarTitle({ title: item.title || "活动详情" });
      const media = this.type === "cases" ? caseMedia(item) : activityMedia(item);
      const tabs = CASE_GROUPS.map(group => ({ ...group, count: media.filter(entry => entry.type === group.key).length }))
        .filter(group => group.count > 0);
      const activeTab = tabs[0] && tabs[0].key || "";
      const cover = catalogCover(item, this.type);
      this.rawItem = item;
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
        activityVideos: media.filter(entry => entry.type === "video"),
        playingIndex: -1
      });
    } catch (error) { this.setData({ loading: false, error: error.message || "加载失败" }); }
  },
  onTab(event) {
    const activeTab = event.currentTarget.dataset.tab;
    const subset = this.allMedia.filter(entry => entry.type === activeTab);
    this.setData({ activeTab, shownMedia: subset.slice(0, PAGE_SIZE), hasMore: subset.length > PAGE_SIZE, playingIndex: -1 });
  },
  onMore() {
    const subset = this.allMedia.filter(entry => entry.type === this.data.activeTab);
    const count = this.data.shownMedia.length + PAGE_SIZE;
    this.setData({ shownMedia: subset.slice(0, count), hasMore: subset.length > count });
  },
  onImage(event) {
    const current = event.currentTarget.dataset.url;
    const images = this.allMedia.filter(entry => entry.type === "image").map(entry => entry.url);
    if (images.includes(current)) wx.previewImage({ current, urls: images });
  },
  onVideo(event) { this.setData({ playingIndex: Number(event.currentTarget.dataset.index) }); },
  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  onShareAppMessage() { return sharePayload(this.rawItem || this.data.item || { id: this.id }, this.type); }
});
