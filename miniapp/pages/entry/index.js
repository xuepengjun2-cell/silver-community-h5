const { parseShareInput, albumPath } = require("../../utils/album");
const { api, login, validateSession, cancelSessionValidation, isSessionCurrent, getLastLoginMethod, wechatSession, applyWechat, applyPlatform, bindWechat } = require("../../utils/auth");
const { PUBLIC_HOME, WORKBENCH, catalogReturnTo } = require("../../utils/navigation");

Page({
  data: {
    loading: true, loginPage: false, wechatLoginAvailable: false, username: "", password: "", busy: false, error: "",
    authMode: "password", lastLoginMethod: "", wechatStatus: "idle", wechatMessage: "", wechatFingerprint: "", showApply: false,
    applyMode: "platform", applicationMessage: "", applicantUsername: "", applicantPassword: "",
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
  onPlatformApplyOpen() {
    if (this.data.busy) return;
    this.setData({ showApply: true, applyMode: "platform", authMode: "password", applicantAgreed: false, error: "", applicationMessage: "" });
  },
  onWechatApplyOpen() {
    if (this.data.busy || !this.data.wechatLoginAvailable || this.data.wechatStatus !== "unbound") return;
    this.setData({ showApply: true, applyMode: "wechat", authMode: "password", applicantAgreed: false, error: "", applicationMessage: "" });
  },
  onBindOpen() {
    if (this.data.busy || !this.data.wechatLoginAvailable || !["unbound", "pending"].includes(this.data.wechatStatus)) return;
    this.setData({ authMode: "bind", showApply: false, password: "", error: "" });
  },
  onCancelWechat() {
    if (this.data.busy) return;
    this.setData({ authMode: "password", showApply: false, password: "", applicantPassword: "", wechatStatus: "idle", wechatMessage: "", wechatFingerprint: "", error: "" });
  },
  onApplyClose() {
    if (this.data.busy) return;
    this.setData({ showApply: false, applicantPassword: "", error: "" });
  },
  onGuest() {
    if (this.data.busy) return;
    this.guestEntry = true;
    cancelSessionValidation(wx);
    this.openPublicHome();
  },
  async onWechatRetry() {
    if (this.data.busy || !this.data.wechatLoginAvailable) return;
    this.setData({ busy: true, authMode: "password", showApply: false, error: "", wechatMessage: "" });
    try {
      const result = await wechatSession(wx, { explicit: true });
      if (result.session) return this.enterSession(result.session);
      this.setData({ wechatStatus: result.status, wechatFingerprint: result.fingerprint || "", wechatMessage: "" });
    } catch (error) { if (!error.cancelled) this.setData({ wechatStatus: "unavailable", wechatMessage: error.message, error: "" }); }
    finally { this.setData({ busy: false }); }
  },
  async onApply() {
    if (this.data.busy) return;
    if (this.data.applyMode === "wechat" && !this.data.wechatLoginAvailable) return this.setData({ error: "微信登录暂未开通，请申请平台账号。" });
    if (!this.data.applicantAgreed) return this.setData({ error: "请先阅读并同意用户隐私保护指引。" });
    const details = {
      name: this.data.applicantName.trim(), contact: this.data.applicantContact.trim(),
      city: this.data.applicantCity.trim(), organization: this.data.applicantOrganization.trim()
    };
    if (!details.name || !details.contact) return this.setData({ error: "请填写真实姓名和联系方式，供总部核实。" });
    const platformApplication = this.data.applyMode === "platform";
    const username = this.data.applicantUsername.trim();
    const password = this.data.applicantPassword.trim();
    if (platformApplication && (!/^[A-Za-z0-9._-]{3,80}$/.test(username) || password.length < 6)) {
      return this.setData({ error: "账号须为 3–80 位字母、数字、点、下划线或短横线；密码至少 6 位。" });
    }
    this.setData({ busy: true, error: "" });
    try {
      if (platformApplication) {
        await applyPlatform(wx, { ...details, username, password });
        this.setData({ username, applicantPassword: "", password: "", showApply: false, applicationMessage: "平台账号申请已提交。总部核实并开通后，可使用此账号登录；审核前不能上传、删除或下载受限资料。" });
      } else {
        const result = await applyWechat(wx, details);
        this.setData({ wechatStatus: result.status || "pending", wechatFingerprint: result.fingerprint || "", showApply: false, wechatMessage: "", applicationMessage: "微信账号申请已提交，请等待总部核实。审核通过后，点击微信登录进入。" });
      }
    } catch (error) { this.setData({ error: error.message || "申请失败" }); }
    finally { this.setData({ busy: false }); }
  },
  async onSubmit() {
    if (this.data.busy) return;
    if (this.data.authMode === "bind" && !this.data.wechatLoginAvailable) return this.setData({ error: "微信绑定暂未开通，请返回平台账号登录。" });
    const username = this.data.username.trim();
    if (!username || !this.data.password) return this.setData({ error: "请输入本平台账号和密码，不是微信密码。" });
    this.setData({ busy: true, error: "" });
    try {
      const session = this.data.authMode === "bind"
        ? await bindWechat(wx, username, this.data.password)
        : await login(wx, username, this.data.password);
      this.setData({ password: "" });
      this.enterSession(session);
    } catch (error) { if (!error.cancelled) this.setData({ error: error.message || "登录失败" }); }
    finally { this.setData({ busy: false }); }
  }
});
