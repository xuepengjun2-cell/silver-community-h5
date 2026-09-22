const { api, getSession } = require("../../utils/auth");
const { mediaUrl } = require("../../utils/urls");

Page({
  data: { loading: true, error: "", item: null, type: "", media: [] },
  onLoad(options) {
    if (!["activities", "cases"].includes(options.type) || !/^[a-z0-9_-]{1,100}$/i.test(options.id || "")) {
      return this.setData({ loading: false, error: "内容编号无效。" });
    }
    this.type = options.type;
    this.id = options.id;
    this.load();
  },
  async load() {
    try {
      const session = getSession(wx);
      const result = await api(wx, `/public/${this.type}/${encodeURIComponent(this.id)}`, { token: session && session.token });
      const item = result.activity || result.case;
      if (!item) throw new Error("该内容暂时无法查看。");
      wx.setNavigationBarTitle({ title: item.title || "活动详情" });
      const gallery = this.type === "activities"
        ? [...(item.images || []).map(url => ({ type: "image", url })), ...(item.videos || []).map(url => ({ type: "video", url }))]
        : item.media || [];
      this.setData({
        loading: false, item: { ...item, cover: mediaUrl(item.cover), images: (item.images || []).map(mediaUrl) },
        type: this.type, media: gallery.map(m => ({ ...m, url: mediaUrl(m.url) })).filter(m => m.url),
        highlights: item.highlights || [], schedule: item.schedule || [], plan: item.plan || {}
      });
    } catch (error) { this.setData({ loading: false, error: error.message }); }
  }
});
