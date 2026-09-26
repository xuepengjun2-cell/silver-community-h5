const { parseShareInput, albumPath } = require("../../utils/album");
const { login, validateSession, wechatSession, applyWechat, bindWechat } = require("../../utils/auth");

Page({
  data: {
    loading: true, username: "", password: "", busy: false, error: "",
    wechatStatus: "checking", wechatMessage: "", wechatFingerprint: "", showApply: false,
    applicantName: "", applicantContact: "", applicantCity: "", applicantOrganization: "", applicantAgreed: false
  },
  async onLoad(options) {
    const parsed = options && options.id ? parseShareInput(options.id) : null;
    if (parsed) return wx.redirectTo({ url: albumPath(parsed.id, parsed.index) });
    let sessionCheckFailed = false;
    try {
      const session = await validateSession(wx);
      if (session) return wx.redirectTo({ url: "/pages/workbench/index" });
    } catch (error) {
      // 断网时保留本地登录态，不能把暂时无网误判为账号过期。
      this.setData({ error: error.message });
      sessionCheckFailed = error.statusCode !== 401;
    }
    if (!sessionCheckFailed) {
      try {
        const result = await wechatSession(wx);
        if (result.session) return wx.redirectTo({ url: "/pages/workbench/index" });
        this.setData({ wechatStatus: result.status, wechatFingerprint: result.fingerprint || "" });
      } catch (error) {
        this.setData({ wechatStatus: "unavailable", wechatMessage: error.message });
      }
    }
    this.setData({ loading: false });
  },
  onUser(event) { this.setData({ username: event.detail.value, error: "" }); },
  onPassword(event) { this.setData({ password: event.detail.value, error: "" }); },
  onApplicantField(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value, error: "" }); },
  onApplicantAgree(event) { this.setData({ applicantAgreed: (event.detail.value || []).includes("agree") }); },
  onPrivacy() {
    if (typeof wx.openPrivacyContract !== "function") {
      return wx.showModal({ title: "隐私保护指引", content: "请先在小程序资料中查看隐私保护指引。", showCancel: false });
    }
    wx.openPrivacyContract({ fail() { wx.showModal({ title: "暂无法打开", content: "请联系总部核对小程序隐私保护指引。", showCancel: false }); } });
  },
  onApplyToggle() { this.setData({ showApply: !this.data.showApply, error: "" }); },
  async onWechatRetry() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      const result = await wechatSession(wx, { explicit: true });
      if (result.session) return wx.redirectTo({ url: "/pages/workbench/index" });
      this.setData({ wechatStatus: result.status, wechatFingerprint: result.fingerprint || "", wechatMessage: "" });
    } catch (error) { this.setData({ wechatStatus: "unavailable", error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  async onApply() {
    if (this.data.busy) return;
    if (!this.data.applicantAgreed) return this.setData({ error: "请先阅读并同意用户隐私保护指引。" });
    this.setData({ busy: true, error: "" });
    try {
      const result = await applyWechat(wx, {
        name: this.data.applicantName, contact: this.data.applicantContact,
        city: this.data.applicantCity, organization: this.data.applicantOrganization
      });
      this.setData({ wechatStatus: result.status, wechatFingerprint: result.fingerprint || "", showApply: false, wechatMessage: "申请已提交，请等待总部核实。" });
    } catch (error) { this.setData({ error: error.message || "申请失败" }); }
    finally { this.setData({ busy: false }); }
  },
  async onSubmit() {
    if (this.data.busy) return;
    const username = this.data.username.trim();
    if (!username || !this.data.password) return this.setData({ error: "请输入原 H5 工作台的账号和密码。" });
    this.setData({ busy: true, error: "" });
    try {
      if (["unbound", "pending"].includes(this.data.wechatStatus)) {
        await bindWechat(wx, username, this.data.password);
      } else {
        await login(wx, username, this.data.password);
      }
      this.setData({ password: "" });
      wx.redirectTo({ url: "/pages/workbench/index" });
    } catch (error) { this.setData({ error: error.message || "登录失败" }); }
    finally { this.setData({ busy: false }); }
  }
});
