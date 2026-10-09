// 所有账号入口统一到 entry，避免活动库、相册和工作台出现不同的登录策略。
const { loginPath } = require("../../utils/navigation");
Page({ onLoad(options) { wx.redirectTo({ url: loginPath(options && options.returnTo) }); } });
