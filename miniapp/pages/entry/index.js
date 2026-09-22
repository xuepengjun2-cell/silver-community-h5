const { parseShareInput, albumPath } = require("../../utils/album");
const { validateSession } = require("../../utils/auth");

Page({
  data: { loading: true, error: "" },
  async onLoad(options) {
    const parsed = options && options.id ? parseShareInput(options.id) : null;
    if (parsed) return wx.redirectTo({ url: albumPath(parsed.id, parsed.index) });
    try {
      const session = await validateSession(wx);
      if (session) return wx.redirectTo({ url: "/pages/workbench/index" });
    } catch (error) {
      // 断网时保留本地登录态，不能把暂时无网误判为账号过期。
      this.setData({ error: error.message });
    }
    this.setData({ loading: false });
  },
  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); }
});
