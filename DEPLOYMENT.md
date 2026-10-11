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
2. 执行 `npm run check`、`npm run test:media`、`npm run test:identity`、`npm run test:concurrency`、`npm run test:sso` 和 `git diff --check`，并确认同SHA的GitHub Check成功。
3. 推送分支并确认远端 commit；经验证后再做非强制快进到 `main`。
4. 服务器先创建带时间戳的代码备份，再从 GitHub 明确 commit 生成临时发布目录。
5. 通过仓库受控发布工具确认上传队列空闲后，停止 silver；仅替换白名单代码和静态文件，排除 `data/`、`uploads/`、`logs/`、`backups/`、`node_modules/`，保留原进程环境再启动。
6. 验收 `/silver-api/health`、`/api/me`、原账号登录、活动/案例/相册分享及媒体访问；异常时只回滚代码备份，不回滚数据库和 TOS 素材。

## 免密入口

视频号助手通过 `#activity_sso=...` 传递一次性短时票据。活动 SOP 只在配置 `ACTIVITY_HUB_SSO_SECRET` 后启用，票据有效期不超过 120 秒且 `jti` 只能消费一次；密钥不进仓库、不写前端。未配置或验签失败时，前端保留原账号密码登录入口。

## 服务器侧脚本

`deploy/update.sh` 只做发布边界检查，发现运行目录被当成 Git 工作树时直接停止；它不会在服务器侧自行拉取未知代码。实际发布必须带明确 GitHub commit，并由受控发布机完成。

## 所有新上传视频的发布卡点

标准与验收操作见 [VIDEO_UPLOAD_STANDARD.md](VIDEO_UPLOAD_STANDARD.md)。默认开启后台处理；`H5_AUTO_VIDEO_DELIVERY=0` 表示暂停新视频上传/处理，返回明确错误，不会恢复任何原片直发。H5 相册、原生小程序相册、后台案例和视频号自动导入都进入同一串行队列。图片与外部 SOP 参考链接保持各自流程。

- 成片实际字节数严格 `<199229440`（190MiB，低于200MB），目标175MiB；MP4/H264/yuv420p、AAC（原片有声音时）、faststart、保留完整音画时长并生成真实首帧 JPEG。格式/大小/时长/头中尾解码、本地文件稳定性及 TOS 对象/封面检查都通过后才允许入库或返回 ready。
- 相册和自动导入原片最多2GiB，后台案例最多300MiB，原生小程序接收最多190MiB。自动处理最长120分钟；超时长、异常文件或无法安全压入边界时失败并提示分段，不裁掉尾部或退回原片。
- PM2必须为silver单fork实例。全平台接收/待处理最多6个任务、后台案例待处理最多3个；FFmpeg逐条执行。临时盘按“原片+190MiB成片+512MiB余量”检查，空间不足拒绝处理。
- 自动导入 complete/retry 返回202 processing；采集器必须轮询 status，只有 completed（带实际成片media）才算成功。失败原片保留供同会话重试；旧completed若未通过现标准不可冒充新上传。
- 新案例视频引用须匹配服务端通过现标准的ready资产；请求的size、poster、fingerprint不能作为证明。历史已发布素材原样编辑仍可保留；草稿发布、移动及相册沉淀须符合现标准，未达标需重新上传处理。
- 先发布带版本参数的app.js/admin.js再验收：上传→processing（不可公开/保存）→completed/ready→成片和封面可读→登录下载/匿名相册分享。实际手机保存需继续用iPhone/安卓验收，后端通过不能替代设备验收。

## 仓库受控发布工具

本地检查和GitHub Check通过、main指向精确目标SHA且工作区干净后执行：

```sh
node deploy/release-from-github.cjs --base=<现网GitHub40位SHA> --sha=<目标main40位SHA>
node deploy/release-from-github.cjs --base=<现网GitHub40位SHA> --sha=<目标main40位SHA> --apply
```

第一条仅预检。工具从GitHub同SHA取代码和远端执行器，核验CI、现网代码基线、依赖不变、空间/队列/PM2；私有备份后短暂停服务，仅替换白名单代码文件，再启动并核对健康JSON、代码哈希和五张业务表哈希。失败只回滚代码，从不回滚业务数据。密钥留在本机和服务器，不提交仓库。
