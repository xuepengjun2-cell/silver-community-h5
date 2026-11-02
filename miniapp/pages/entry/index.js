const { parseShareInput, albumPath } = require("../../utils/album");
const { api, login, validateSession, cancelSessionValidation, isSessionCurrent, getLastLoginMethod, wechatSession, onboardWechat, bindWechat } = require("../../utils/auth");
const { PUBLIC_HOME, WORKBENCH, catalogReturnTo } = require("../../utils/navigation");

Page({
  data: {
    loading: true, loginPage: false, wechatLoginAvailable: false, username: "", password: "", busy: false, error: "",
    authMode: "password", showOtherLogin: false, lastLoginMethod: "", wechatStatus: "idle", wechatMessage: "", wechatFingerprint: "", showApply: false,
    applicantName: "", applicantContact: "", applicantCity: "", applicantOrganization: "", applicantAgreed: false
  },
  async onLoad(options) {
    const parsed = options && options.id ? parseShareInput(options.id) : null;
    if (parsed) {
      this.shareEntry = true;
      return wx.redirectTo({ url: albumPath(parsed.id, parsed.index) });
    }
    this.explicitLogin = options && options.mode === "login";
    this.returnTo = this.explicitLogin ? catalogReturnTo(options.returnTo) : "";
    this.setData({ loginPage: Boolean(this.explicitLogin) });
    if (this.explicitLogin) this.loadCapabilities();
    return this.restoreSession();
  },
  onShow() {
    if (!this.shareEntry && !this.guestEntry && !this.redirecting) return this.restoreSession();
  },
  restoreSession() {
    if (this.restoring) return this.restoring;
    if (this.data.busy) return Promise.resolve();
    const pending = (async () => {
      try {
        const session = await validateSession(wx);
        if (!this.guestEntry && session && isSessionCurrent(wx, session)) {
          this.redirecting = true;
          wx.redirectTo({ url: this.returnTo || WORKBENCH });
        } else if (!this.explicitLogin && !this.guestEntry && !this.redirecting) {
          this.openPublicHome();
        }
      } catch (error) {
        // 断网时保留本地登录态，不能把暂时无网误判为账号过期。
        if (!error.cancelled) {
          if (!this.explicitLogin && !this.guestEntry && !this.redirecting) this.openPublicHome();
          else this.setData({ error: error.message });
        }
      } finally { this.setData({ loading: false, lastLoginMethod: getLastLoginMethod(wx) }); }
    })().finally(() => { if (this.restoring === pending) this.restoring = null; });
    this.restoring = pending;
    return pending;
  },
  loadCapabilities() {
    if (this.capabilitiesPromise) return this.capabilitiesPromise;
    // 能力检测只影响可选微信入口，不阻塞密码登录、申请或公开浏览。
    this.capabilitiesPromise = api(wx, "/auth/capabilities")
      .then(result => this.setData({ wechatLoginAvailable: Boolean(result.capabilities && result.capabilities.wechatLogin === true) }))
      .catch(() => this.setData({ wechatLoginAvailable: false }));
    return this.capabilitiesPromise;
  },
  openPublicHome() {
    this.redirecting = true;
    wx.redirectTo({ url: PUBLIC_HOME });
  },
  enterSession(session) {
    if (this.guestEntry || !isSessionCurrent(wx, session)) return;
    this.redirecting = true;
    wx.redirectTo({ url: this.returnTo || WORKBENCH });
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
  onOtherLogin() {
    if (this.data.busy) return;
    this.setData({ showOtherLogin: !this.data.showOtherLogin, authMode: "password", showApply: false, password: "", error: "" });
  },
  onBindOpen() {
    if (this.data.busy || !this.data.wechatLoginAvailable || !["unbound", "pending"].includes(this.data.wechatStatus)) return;
    this.setData({ authMode: "bind", showOtherLogin: true, showApply: false, password: "", error: "" });
  },
  cancelAuth() {
    this.authAttempt = (this.authAttempt || 0) + 1;
    cancelSessionValidation(wx);
  },
  onCancelWechat() {
    this.cancelAuth();
    this.setData({ busy: false, authMode: "password", showOtherLogin: true, showApply: false, password: "", wechatStatus: "idle", wechatMessage: "", wechatFingerprint: "", error: "" });
  },
  onApplyClose() { this.onCancelWechat(); },
  onUnload() { this.guestEntry = true; this.cancelAuth(); },
  onGuest() {
    this.guestEntry = true;
    this.cancelAuth();
    this.openPublicHome();
  },
  async onWechatRetry() {
    if (this.data.busy || !this.data.wechatLoginAvailable || this.guestEntry) return;
    const attempt = this.authAttempt = (this.authAttempt || 0) + 1;
    this.setData({ busy: true, authMode: "password", showOtherLogin: false, showApply: false, error: "", wechatMessage: "" });
    try {
      const result = await wechatSession(wx, { explicit: true });
      if (attempt !== this.authAttempt || this.guestEntry) return;
      if (result.session) return this.enterSession(result.session);
      this.setData({ wechatStatus: result.status, wechatFingerprint: result.fingerprint || "", wechatMessage: "",
        showApply: result.status === "unbound", authMode: result.status === "unbound" ? "onboard" : "password" });
    } catch (error) {
      if (attempt === this.authAttempt && !this.guestEntry && !error.cancelled) this.setData({ wechatStatus: "unavailable", wechatMessage: error.message, error: "" });
    } finally { if (attempt === this.authAttempt) this.setData({ busy: false }); }
  },
  async onApply() {
    if (this.data.busy || this.guestEntry) return;
    if (!this.data.applicantAgreed) return this.setData({ error: "请先阅读并同意用户隐私保护指引。" });
    if (!this.data.wechatLoginAvailable || !this.data.showApply || this.data.wechatStatus !== "unbound" || this.data.authMode !== "onboard") return;
    const details = {
      name: this.data.applicantName.trim(), contact: this.data.applicantContact.trim(),
      city: this.data.applicantCity.trim(), organization: this.data.applicantOrganization.trim(), agreed: true
    };
    if (details.name.length < 2 || details.name.length > 60) return this.setData({ error: "请填写 2–60 字的姓名。" });
    if (details.contact.length < 6 || details.contact.length > 80) return this.setData({ error: "请填写 6–80 字的联系方式，供总部核实。" });
    if (!details.organization || details.organization.length > 120) return this.setData({ error: "请填写俱乐部／社群名称（不超过 120 字）。" });
    if (details.city.length > 80) return this.setData({ error: "城市请填写不超过 80 字，也可留空。" });
    const attempt = this.authAttempt = (this.authAttempt || 0) + 1;
    this.setData({ busy: true, error: "" });
    try {
      const session = await onboardWechat(wx, details);
      if (attempt === this.authAttempt && !this.guestEntry) this.enterSession(session);
    } catch (error) {
      if (attempt === this.authAttempt && !this.guestEntry && !error.cancelled) this.setData({ error: error.message || "开通失败，请稍后重试。" });
    } finally { if (attempt === this.authAttempt) this.setData({ busy: false }); }
  },
  async onSubmit() {
    if (this.data.busy || this.guestEntry) return;
    if (this.data.authMode === "bind" && !this.data.wechatLoginAvailable) return this.setData({ error: "微信绑定暂未开通，请返回平台账号登录。" });
    const username = this.data.username.trim();
    if (!username || !this.data.password) return this.setData({ error: "请输入本平台账号和密码，不是微信密码。" });
    const attempt = this.authAttempt = (this.authAttempt || 0) + 1;
    this.setData({ busy: true, error: "" });
    try {
      const session = this.data.authMode === "bind"
        ? await bindWechat(wx, username, this.data.password)
        : await login(wx, username, this.data.password);
      if (attempt !== this.authAttempt || this.guestEntry) return;
      this.setData({ password: "" });
      this.enterSession(session);
    } catch (error) { if (attempt === this.authAttempt && !this.guestEntry && !error.cancelled) this.setData({ error: error.message || "登录失败" }); }
    finally { if (attempt === this.authAttempt) this.setData({ busy: false }); }
  }
});
