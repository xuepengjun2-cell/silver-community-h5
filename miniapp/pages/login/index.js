// 所有账号入口统一到 entry，避免活动库、相册和工作台出现不同的登录策略。
Page({ onLoad() { wx.redirectTo({ url: "/pages/entry/index" }); } });
