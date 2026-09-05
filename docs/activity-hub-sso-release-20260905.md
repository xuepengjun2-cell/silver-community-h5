# 活动 SOP 单点进入发布说明（2026-09-05）

- 视频号助手签发 120 秒 HMAC-SHA256 短时票据，活动平台独立核验并立即清除 URL fragment；不共享密码和 Cookie。
- 一次性 `jti` 写入 MySQL，重复票据返回 409。
- 已有绑定沿用活动平台原权限；首次进入仅创建 `member`；同名、停用或冲突账号拒绝自动恢复。
- 活动平台会话最长 7 天，并且不超过视频号助手账号有效期。
- 两端必须配置同一份 `ACTIVITY_HUB_SSO_SECRET`；视频号助手入口为 `https://proj2.likeduoduiyi.cn/silver/`。
- 发布验证：`npm run check`、`npm run test:sso`、健康接口、无效签名、重复票据、首次建号、原密码登录回归。
