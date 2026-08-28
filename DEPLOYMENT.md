# Silver 活动相册生产部署规范

## 代码源

GitHub：`https://github.com/xuepengjun2-cell/silver-community-h5`

生产代码以 GitHub `main` 上的明确 commit 为准。服务器目录 `/var/www/silver-community-h5` 不作为代码编辑源；TOS/CDN 静态资源也不作为反向代码源。

## 三方同步边界

- GitHub：版本管理、代码审查、提交记录和发布依据。
- 服务器：Node 服务、PM2、环境变量、MySQL 连接和运行时上传目录。
- TOS/CDN：前台/后台静态资源与活动媒体对象。

数据库、上传视频/图片、TOS 媒体对象和环境文件不随代码发布覆盖。

## 标准发布节奏

```text
GitHub 分支开发
  -> 本地 node --check / 回归检查
  -> 提交并推送 GitHub
  -> 以明确 commit 生成发布包
  -> 备份服务器代码、运行时配置和 TOS/CDN 对象
  -> 先发布/重启单一服务并检查健康状态
  -> 发布 TOS/CDN 静态资源并做公网回读
  -> 验收登录、后台权限、活动相册、图片/视频播放和下载
  -> 记录 commit、备份路径、哈希和回滚命令
```

## 生产热修复

只有阻断性问题且获得明确授权时，才允许在服务器做短期热修复。热修复必须立即回补 GitHub，并在下一次发布前完成三方哈希复核；日常功能不允许绕过 GitHub 直接改服务器或 TOS/CDN。

## 当前运行形态

- PM2 应用：`silver`
- 服务器目录：`/var/www/silver-community-h5`
- 服务端口：`5174`
- 前台：`https://proj2.likeduoduiyi.cn/silver/`
- API：`https://apip2.kkhuacai08.cn/silver-api`
- TOS/CDN 发布前缀：`silver/`
