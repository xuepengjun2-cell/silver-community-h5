# Photo Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 缩小相册浏览资源，翻图复用已授权数据，保留原图下载。
**Architecture:** 后端纯DTO派生小图/预览URL，大图使用独立受控sidecar队列；浏览器使用三级资源、短期权限快照和有界相邻预取。
**Tech Stack:** 现有Node/mysql2/TOS/FFmpeg和原生浏览器，无新增依赖。
**Spec:** docs/superpowers/specs/2026-10-31-photo-browsing-design.md

## Global Constraints

- 基线817adef72c46843d5ecb4d3caf3a9e83f2c25689；仅网页和后端，原图m.url/下载/权限保持，视频和小程序不改。
- 不改initDb、SQL结构、依赖/锁文件、共享桶策略/ACL/CORS；不删除客户原片或覆盖业务文档。DTO衍生字段不写SQL。
- 列表最长边640，预览1600，质量82，固定URL和一年缓存；GIF/SVG/未知外部资源不转换。
- 在线处理最大20MiB，大图输入最大50MiB/64MP；单线程低优先级，内存768MiB、负载1.6、磁盘1GiB加256MiB守卫，忙视频时让行。
- 元数据仅内存，账号/相册/public-my隔离，最多15秒；到期重验、失败不延长权限；图片已缓存不等于可以绕过服务端下载核验。
- 邻图只预取一张，最多3个Image引用；弱网/Save-Data不预取，离开清理。待衍生状态每2秒核对、最多30秒。
- 精确GitHub/main CI后发布；无活动上传及衍生任务才能停服；后端与TOS静态分别备份、哈希读回，不回滚业务数据库。

## Review Focus

1. 大于20MiB原片不能简单在线缩放报错后无限重试；pending/失败仍可主动查看和下载原图。
2. 元数据缓存不能跨账号/公开私有范围复用；删除/重排后下载不能落到错误照片。
3. 旧异步响应和快速连续翻图不得覆盖当前选择；预取不得抢占原图/当前图或持续泄漏。
4. 源ETag替换、sidecar损坏或进程退出时，半成品不能作为ready发布，不删除任何源文件。
5. 忙视频、空间/内存紧张与正式发布并存时，新照片工作不得绕过既有服务守卫。

## Shared Interfaces

- DTO图片追加`thumbnailUrl?:string,previewUrl?:string,imageViewState?:'ready'|'pending'|'unavailable'`，原`url,size,type`不变；未就绪大图不提供虚假成品URL。未知资源不追加字段。
- 小图处理参数：`image/auto-orient,1/resize,m_lfit,w_640,h_640,limit_1/quality,q_82`；预览同样1600。处理只作用受控项目/案例图片前缀。
- 新模块`server/photo-views.js`导出`createPhotoViews(options)`；返回`decorate(media)`, `request(media)`, `isBusy()`, `stop()`。decorate同步返回新对象，可调度异步工作；options注入`stateFile,stagingRoot,getStorage,resolveSource,isReferenced,canRun`等外部边界，具体小型内部函数由实现者决定。
- 独立sidecar`data/photo-views.json`；工作目录`data/.photo-view-staging/`，active标记由后端维护供发布检查，任务键/文件名必须受控。配置只用于本模块，不修改共享TOS客户端；已验证可用时复用internal端点。
- 原图下载可选参数`expectedUrl`，后端仅比较当前槽位原URL，不做任意URL代理；不一致409，旧客户端不带参数不变。

### Task 1: bounded photo-view service and DTO integration

**Files:** create server/photo-views.js, tests/photo-views.test.js, tests/photo-views-api.test.js; modify server.js, server/miniapp-media.js exports only if reusing existing cancellable `run`/`probe`; own backend fixture changes tests/support/video-api-server.js, tests/concurrency/fake-tos.js/fake-mysql.js only if needed.
**Produces:** Shared DTO fields/service; pending worker marker and safe shutdown; optional download expectedUrl guard. Own no public files/package/deploy.

- [ ] Write failing pure/API tests:640/1600 stableURL and original unchanged;20MiB boundary; unknown/GIF/SVG bypass; injected client derivative URL cannot become trusted; DTO additions leave persisted documents identical.
- [ ] Implement decorator for small controlled raster URLs and durable big-image sidecar queue. Ready only after both storage outputs verified; source size/ETag before/after, scope/ref revalidation, retry/backoff, corrupt cache and restart handling.
- [ ] Test resource guards, video busy, cancellation/exit, source replacement, duplicate queue/copy, partial upload failure; preserve originals and no stale worker finalization. Generate derivatives using existing cancellable low-priority media runner with single threads,60s/tool180s/job, pixel and byte limits. Reuse run/probe via additive exports rather than duplicate subprocess manager.
- [ ] Integrate account/public project and appropriate case DTOs without modifying normalization/startup; add expectedUrl guard to project download endpoints. API tests unauthorized, share closed, reorder mismatch409 and legacy compatibility. Queue only current referenced controlled images; upload does not wait for optional derivative work.
- [ ] Run focused tests plus backend identity/concurrency where touched. Real codec assertions must run with FFmpeg on Linux CI; report local absence. Self-review RED/GREEN evidence; controller commits owned files.

### Task 2: browser tiers, authorization-scoped navigation and bounded prefetch

**Files:** modify public/app.js/public/styles.css; create tests/photo-browsing-ui.test.js; own relevant existing frontend tests only. No server/fixtures/package/HTML edits.
**Consumes:** Shared DTO fields, expectedUrl download guard; small legacy records without derived fields can construct exact stable transforms only for known controlled URL+safe size. Prefer server DTO.

- [ ] Write actual-function RED tests: grid640 vs preview1600 vs untouched downloadURL; pending huge image does not silently start original transfer; GIF/unknown retain compatibility; error fallback bounded and original button visible.
- [ ] Implement central image source helper and bindings for album cards/cover, independent preview/old lightbox, and case image display where compatible. Add async decode, current priority, clear browser-vs-original saving copy and “查看原图”/“返回清晰预览”. Keep video widgets and case login-download gate intact.
- [ ] Implement15s max per-account/project/scope metadata snapshot. Direct routes always verify, within-session next/prev uses snapshot; expiry/focus/user changes/upload/delete reverify/invalidate. Use navigation generations for rapid clicks and returns. Revalidation remaps selected originalURL; removed item does not jump to another. Test share close/403, offline expiry, reorder, logout/login and delayed responses.
- [ ] Current image load triggers at most one next-preview prefetch. Skip weak networks/Save-Data, keep at most3 image refs, clear old handlers/network on exit/project/actor change. Test bounded concurrency and no original prefetch. Pending derivative poll2s up to30s, navigation-safe, no indefinite polling.
- [ ] Download requests attach expectedUrl of visible source; original-mode changes display only. Test original download safety and unchanged mobile video/case auth. Run relevant existing UI/task tests, self-review/report; controller commits owned files.

### Task 3: CI/release guards, static version and end-to-end acceptance

**Files:** package.json scripts, public/index.html cache tags, deploy/release-from-github.cjs, tests/release-from-github.test.js, VIDEO_UPLOAD_STANDARD.md, DEPLOYMENT.md. Optional narrow regression fixture if contract gap. No lock/workflow changes.

- [ ] RED test active photo-view staging marker blocks release before/after stop even with SQL0; orphan ambiguity must fail closed. Implement guard without deleting working files or changing original uploads guard.
- [ ] Wire tests/check syntax into existing CI scripts; version app/styles `20261031-photo-browse1`; document derivative/state/recovery/download tiers and compatibility limits. Code-only/sidecar preservation on rollback, no database mutation.
- [ ] Once Tasks1/2 settle, run Linux full CI/real codec and actual API/frontend contracts. Browser tests weak/normal networks, rapid next/back, metadata request counts, original mode, current/neighbor resources, restored scrolling and no JS errors. Compare actual resized bytes without claiming phone timings from server-only evidence.
- [ ] Independent whole-branch review, fix and scoped rereview, GitHub/main CI, then fresh production idle/hash inventory. Release exact artifacts and verify public code hashes, account/share access, original image HEAD/SHA samples and generated-large derivatives. Do not interrupt active client uploads or alter other modules/data.
