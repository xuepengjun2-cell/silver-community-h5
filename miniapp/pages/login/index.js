const { login } = require("../../utils/auth");

Page({
  data: { username: "", password: "", busy: false, error: "" },
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
