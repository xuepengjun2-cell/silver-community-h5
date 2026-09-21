const { parseShareInput, albumPath } = require("../../utils/album");

Page({
  data: { link: "", error: "" },
  onLoad(options) {
    const parsed = options && options.id ? parseShareInput(options.id) : null;
    if (parsed) wx.redirectTo({ url: albumPath(parsed.id, parsed.index) });
  },
  onInput(event) { this.setData({ link: event.detail.value, error: "" }); },
  onOpen() {
    const parsed = parseShareInput(this.data.link);
    if (!parsed) {
      this.setData({ error: "请粘贴已发布的活动相册分享链接。" });
      return;
    }
    wx.navigateTo({ url: albumPath(parsed.id, parsed.index) });
  }
});
