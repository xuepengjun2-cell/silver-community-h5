const { parseShareInput, albumPath } = require("../../utils/album");
const { login, validateSession } = require("../../utils/auth");

Page({
  data: { loading: true, username: "", password: "", busy: false, error: "" },
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
  onUser(event) { this.setData({ username: event.detail.value, error: "" }); },
  onPassword(event) { this.setData({ password: event.detail.value, error: "" }); },
  async onSubmit() {
    if (this.data.busy) return;
    const username = this.data.username.trim();
    if (!username || !this.data.password) return this.setData({ error: "请输入原 H5 工作台的账号和密码。" });
    this.setData({ busy: true, error: "" });
    try {
      await login(wx, username, this.data.password);
      this.setData({ password: "" });
      wx.redirectTo({ url: "/pages/workbench/index" });
    } catch (error) { this.setData({ error: error.message || "登录失败" }); }
    finally { this.setData({ busy: false }); }
  }
});
