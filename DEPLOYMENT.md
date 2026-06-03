# GitHub + Railway 自动化上线流程

## 当前部署形态

当前项目是一个 Node.js 单服务：

- `server.js` 提供前台页面、后台页面、API、登录、上传、SOP 下载。
- `public/` 是前台和后台静态资源。
- `data/db.json` 是初始活动和账号数据。
- 线上运行时数据建议通过 Railway Volume 持久化。

## 一、上传到 GitHub

```bash
cd silver-community-h5
git init
git add .
git commit -m "Initial Railway deploy"
git branch -M main
git remote add origin <你的 GitHub 仓库地址>
git push -u origin main
```

注意：

- `.gitignore` 已排除 `data/sessions.json`、`uploads/*`、`.tools/`、`npm`、`npx` 和 zip 包。
- `data/db.json` 和 `data/seed-activities.json` 会提交，用于线上首次初始化。

## 二、Railway 创建服务

1. 打开 Railway，新建 Project。
2. 新建 Service，选择 `Deploy from GitHub repo`。
3. 选择这个 GitHub 仓库。
4. 分支选择 `main`。
5. Railway 会读取根目录的 `railway.json`。

项目已配置：

- Builder：`RAILPACK`
- Start command：`npm start`
- Healthcheck：`/healthz`
- Restart policy：失败自动重启

## 三、挂载 Volume，保证数据不丢

后台会修改活动、账号，并上传图片；这些属于运行时数据，必须持久化。

在 Railway：

1. 给当前 Service 添加 Volume。
2. Mount path 建议设置为：

```text
/storage
```

应用会自动读取 Railway 注入的 `RAILWAY_VOLUME_MOUNT_PATH`，并把数据写到：

```text
/storage/data
/storage/uploads
```

如果没有挂 Volume，数据会写在容器临时文件系统里，重新部署后可能丢失。

## 四、自动化发布流程

上线后日常流程：

```bash
git add .
git commit -m "Update UI or activity logic"
git push
```

自动发生：

1. GitHub Actions 跑 `npm run check` 和 `npm run smoke`。
2. Railway 监听 GitHub `main` 分支新提交。
3. Railway 自动构建。
4. Railway 启动 `npm start`。
5. Railway 访问 `/healthz` 检查成功后切换新版本。

## 五、域名绑定

在 Railway Service 的 Networking / Domains 里：

1. 先生成 Railway 默认域名，确认能访问。
2. 再添加自定义域名，例如：

```text
sop.yourcompany.com
```

3. 按 Railway 提示去域名服务商添加 CNAME。
4. 等 HTTPS 自动签发完成。

## 六、上线前检查

本地先跑：

```bash
npm run check
npm run smoke
```

访问：

```text
http://localhost:5174/healthz
http://localhost:5174/
http://localhost:5174/admin
```

## 七、当前演示账号

- 管理员：admin / admin123
- 城市主理人：city / city123
- 普通学习用户：member / member123

正式上线后，请第一时间在后台修改这些账号密码。

## 八、后续产品化建议

当前 `db.json + Volume` 适合试运营。等主理人数量、活动上传和权限管理变多后，建议升级为：

- PostgreSQL：用户、活动、权限、审核记录
- Railway/S3-compatible Bucket：图片和视频素材
- 操作日志：记录谁修改、谁审核、谁下载
- 分环境：staging 和 production
