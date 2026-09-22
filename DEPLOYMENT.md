# 活动 SOP GitHub-first 发布说明

## 发布边界

- 本仓库只负责活动 SOP 服务；视频号助手由其自己的仓库和发布流程负责。
- GitHub 的目标 commit 是唯一发布输入。服务器 `/var/www/silver-community-h5` 是运行目录，不作为 Git 工作树，也不允许直接编辑或 `git pull`。
- MySQL 数据、TOS 素材、`uploads/`、`logs/` 和 `backups/` 属于运行态，发布时必须保留，不从代码仓库覆盖。

## 现网组件

- PM2 进程：`silver`
- Node 服务端口：`5174`
- 公网 API：`https://apip2.kkhuacai08.cn/silver-api/`
- 公网静态站：`https://proj2.likeduoduiyi.cn/silver/`（新域名启用后可通过 `https://deruichi.cn/silver/` 访问同一份静态对象）
- 数据库：由 `/etc/silver-community.env` 注入，严禁提交到 GitHub

## 受控发布顺序

1. 在开发机从最新 `origin/main` 建发布分支，基于服务器线上代码和当前 CDN 静态文件合并修改。
2. 执行 `npm run check`、`npm run test:sso` 和 `git diff --check`。
3. 推送分支并确认远端 commit；经验证后再做非强制快进到 `main`。
4. 服务器先创建带时间戳的代码备份，再从 GitHub 明确 commit 生成临时发布目录。
5. 仅同步代码和静态文件，排除 `data/`、`uploads/`、`logs/`、`backups/`、`node_modules/`，然后执行 `pm2 reload silver --update-env`。
6. 验收 `/silver-api/health`、`/api/me`、原账号登录、活动/案例/相册分享及媒体访问；异常时只回滚代码备份，不回滚数据库和 TOS 素材。

## 免密入口

视频号助手通过 `#activity_sso=...` 传递一次性短时票据。活动 SOP 只在配置 `ACTIVITY_HUB_SSO_SECRET` 后启用，票据有效期不超过 120 秒且 `jti` 只能消费一次；密钥不进仓库、不写前端。未配置或验签失败时，前端保留原账号密码登录入口。

## 服务器侧脚本

`deploy/update.sh` 只做发布边界检查，发现运行目录被当成 Git 工作树时直接停止；它不会在服务器侧自行拉取未知代码。实际发布必须带明确 GitHub commit，并由受控发布机完成。

## H5 新上传视频自动生成 MP4（受控功能）

- 代码默认不接管现有上传。只有在服务进程环境设置 `H5_AUTO_VIDEO_DELIVERY=1` 后，案例后台新上传和活动相册 H5 新上传才改走串行 FFmpeg 交付队列；历史案例、历史相册、视频号采集器直传和外部 SOP 链接不自动改写。
- 发布前检查 FFmpeg/FFprobe、MySQL、TOS 和临时盘余量；至少留出“当前最大原片 + 190 MB 输出 + 512 MB 安全余量”。生产机只有 2 核，不能并发跑大视频，案例原片同时待处理最多 3 条。服务端会拒绝超过 300 MB 的后台案例上传、超过 2 GB 的 H5 相册上传，超 40 分钟或无法压入交付边界时提示分段。
- 先发布并核验带新版本号的 H5 `app.js`/`admin.js`，再在隔离/受控环境开启开关；否则旧浏览器脚本会把后台返回的 `processing` 当作上传完成。各验一条案例 MOV、一条大相册 MOV：原片分片上传 → `processing` → MP4 入库 → CDN 可访问 → 下载权限/匿名分享 → iPhone、安卓、鸿蒙保存 → 检查本次新原片删除。任何一步失败都不要开启全量；转码失败的相册原片会保留并可通过同一会话重试。
- 发现业务异常时将开关恢复为 `0` 并重载服务；待处理会话标为可重试，不回滚 MySQL/TOS，也不删除已生成的交付版。定位完成后恢复开关并由用户重新选择同一文件续办。历史素材另行排队迁移。
