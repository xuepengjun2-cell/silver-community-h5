# Unified Resumable Album Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 照片和视频分片直传TOS，慢传可见、可停止和续传，重复请求不产生重复素材。
**Architecture:** 复用现有会话表和鉴权接口，照片增加独立的受控发布队列；原视频处理及资源限制保留。浏览器统一分片传输和文件批次状态，用真实字节进度、有限等待和持久化请求标识恢复传输。
**Tech Stack:** Node.js18+、现有mysql2与TOS SDK2.9.1、原生浏览器XHR/Fetch/FileReader/WebCrypto、node:test；无新增运行时依赖。
**Spec:** `docs/superpowers/specs/2026-10-31-unified-album-upload-design.md`

## Global Constraints

- 新网页JPEG/PNG/WebP/GIF直传TOS，SVG走既有兼容接口并补进度/期限；不改变照片质量和历史素材。
- 照片50MiB，视频原片2GiB、120分钟；视频仍须原有MP4/H264/AAC、严格小于199229440字节、完整时长和JPEG封面检查。
- 不修改initDb或数据库结构、不改变依赖或锁文件、不修改miniapp/，不改共享桶策略/ACL/CORS。
- 只有上传者或总部管理员且仍有相册管理权限可控制；上传者失权后不能继续发布。公开相册分享下载保持原边界。
- 视频名额6、串行单线程低优先级不变；照片发布独立串行、最大临时输入50MiB并检查空间。
- 生产当前公有桶不等于私有暂存；新暂存不返回分享页、不接受任意URL、键或客户端大小/指纹证明。不将随机路径声明为访问控制。
- 后端保留旧视频及整张照片协议。新照片会话使用已有type/ext/status字段；按类型隔离恢复/调度。
- GitHub分支/CI/main明确SHA后受控发布；仅服务器、网页及TOS静态，不上传小程序。无活动任务及旧照片临时文件时才能发布。

## Review Focus

1. 初始化响应丢失或完成响应丢失：原会话可查询/复用，同一标识不同文件元数据被拒绝。
2. 持续慢速传输超过旧180秒：有真实字节进度，不能误判空闲；真正无进展有期限并释放批次。
3. 停止后立即继续以及撤销权限：旧执行不能覆盖新执行或发布，源文件与旧素材保留。
4. 重复文件及已完成素材后被删除：只复用仍在当前相册的可信结果，不能凭客户端URL重新发布。
5. 旧照片没有会话行：发布空闲检查必须同时核验临时文件，不能仅依赖SQL任务数。

## Interfaces shared by Tasks1 and2

- `POST /api/my/activity-projects/:projectId/media/init` body `{type:'image'|'video',ext,title,size,clientUploadId?:32lowerhex,fingerprint?:64lowerhex}`。fingerprint只用于照片已有可信对象查重。
- 响应保留旧字段，新增可选`type`、`duplicate`。普通会话返回`sessionId,fileSize,partSize,partCount,status:'uploading'`；已有完整结果可返回`status:'completed',sessionId,media,duplicate:true`。
- `clientUploadId`在首次初始化前持久化；服务端按账号+相册+标识派生会话主键并串行初始化。旧客户端不传标识仍按旧方式创建。
- 复用既有`.../upload-session/:id/{part-url,status,complete?delivery=1,pause,resume,dismiss}`。照片与视频均返回`status,progress`，完成返回`media`或可用的`mediaUrl`，重复完成幂等；同类型分片记录按服务端元数据核验。
- 新照片分片8MiB，视频保留16MiB兼容值；旧会话始终沿用已存partSize。浏览器每文件最多2片并发；TOS PUT不带平台Cookie。
- 读控制请求每次30秒、最多3次，对网络/超时/408/429/5xx重试；权限/格式等4xx不盲目重试。初始化和完成仅在同一幂等标识或状态核对后重试。
- XHR分片无进展90秒取消；有进展则重置，分片绝对上限30分钟；最多4次PUT尝试。完整响应和JSON消费都受控制请求期限覆盖。
- 任务列表返回类型、进度及总数，保留旧`sessions`字段；可返回最多1000项，前端默认50项并可展开，正在处理/当前上传项不能隐藏。

### Task 1: durable direct-photo backend and idempotent session protocol

**Files:** Modify `server.js`, `server/project-video-tasks.js`, `server/video-delivery-io.js` if required; create `server/project-image-delivery.js`, `tests/project-image-delivery.test.js`, `tests/project-photo-upload-api.test.js`; own relevant changes in `tests/support/video-api-server.js` and `tests/concurrency/fake-mysql.js`, `fake-tos.js`; adjust existing backend tests only where protocol intentionally changes.
**Consumes:** existing createProjectVideoTasks lifecycle, trusted project commit/persistence, TOS SDK, shared interfaces above.
**Produces:** shared HTTP protocol; `validateProjectImage(file,{ext,expectedSize,signal}) -> Promise<{size,fingerprint,contentType}>`; image queue with independent serial execution and stage progress; no image job enters video processor.

- [ ] Write API tests rejecting unsupported/oversize image init, accepting valid photo init, and routing photo upload through multipart instead of legacy raw receiver. Run them first and record expected failure against486d5d5.
- [ ] Add tests for concurrent identical clientUploadId -> exactly one session/TOS initiation; changed account/project computes distinct namespace; changed size/type/title for same identifier rejects409; no identifier preserves old video API.
- [ ] Implement typed initialization and existing-session dispatch using current table fields and single-process locking; use no schema change. Duplicate-photo lookup may only return an existing project image whose server-owned fingerprint and actual size match, and must leave a completed receipt so inputs remain countable.
- [ ] Write image delivery tests with real bytes for JPEG/PNG/WebP/GIF, wrong type/empty/truncated object, SHA calculated server-side, abort and object change. Use bounded, structural validation and any required existing media tools without altering pixels or animation; SVG rejected in this new branch.
- [ ] Implement photo worker: merge/head validated source; stage read/hash with size/space/abort guards; native TOS copy to controlled photo key with source ETag precondition; HEAD/readback then fresh permission/dedup-at-commit/persistence. Store resulting canonical mediaURL in receipt, clean only this source after confirmation; failed or stopped jobs retain source and never delete published files.
- [ ] Use separate photo lifecycle instance/serial queue; existing helper may accept defaulted maxPending/type labels. Video queries accept onlyvideo; photo queries accept onlyimage. Preserve old paused/dismissed and stale-controller protections; resume both on restart and recover fully arrived sources.
- [ ] Add tests for photo finish while a delayed video runs, partial pause/resume, lost complete response, immediate stop/resume, account revocation across HEAD/copy/commit, duplicate finish, deleted completed reference, failed copy/DB and source retention. Run new tests plus `npm run test:tasks`, `npm run test:concurrency`, `npm run test:identity`.
- [ ] Self-review and report RED/GREEN commands/results, touched files and code concerns; controller commits only Task1 files before independent review.

### Task 2: browser multipart transport and mixed-batch usability

**Files:** Modify `public/app.js`, `public/styles.css`; create `tests/project-upload-transport.test.js`, `tests/project-mixed-batch.test.js`; own relevant updates to existing UI tests. Do not modify server files, fixtures, package.json or HTML cache versions.
**Consumes:** shared HTTP contract; current H5 state/render and existing pause/resume actions.
**Produces:** unified raster photo/video multipart in `uploadProjectMediaFile`; bounded upload-control API wrapper; XHR part/legacySVG transport; serial batch manifest, visible counts and expandable task state.

- [ ] Start from actual functions and add failing tests: mixed40 stalled first photo cannot wait forever, photo selects direct multipart, no raw photo POST; no-progress part expires but progress continuing past180seconds remains alive. Keep external network mocked at transport only.
- [ ] Implement cancellable XHR PUT progress and finite idle/absolute limits above; reconcile confirmed and in-flight bytes correctly, including resets/retries; AbortError never accidentally starts another transfer. SVG fallback gets the same observable bounded transport on its existing POST endpoint.
- [ ] Persist clientUploadId/session receipt before init and after queued/completed; old video local state remains readable. Add tests for lost init/complete reply, querying a queued or completed existing session without duplicate upload, original file reselection after partial interruption, changed file metadata and cleared/deleted server reference.
- [ ] For photos only, use abortable FileReader and WebCrypto when available to look up trusted existing content before transfer; no whole-video hashing or2GiB buffering. Hash phase is distinct from upload bytes; unsupported hashing falls back safely to server validation.
- [ ] Add one file controller before init and propagate it through status/signature/PUT/complete/JSON. Permit stop/skip of the current file before its session exists; preserve cloud parts when pausing, continue remaining batch where appropriate; don't silently discard failed items.
- [ ] Render chosen40 input rows/statuses and current bytes/speed/phase/retry, distinguish uploaded from published and duplicate results; update counts/media without resetting unsaved activity form input. Failed/paused outcomes don't count as published, and each input reaches a visible finite outcome.
- [ ] Bound polling and reschedule in finally. Tests cover hung poll followed by recovery, more than50 outstanding tasks with current/oldest processing visible, and old photo response compatibility.
- [ ] Run new tests and relevant existing UI/miniapp tests; self-review and report RED/GREEN evidence. Controller commits only Task2 files before independent review.

### Task 3: integration, guarded release and documentation

**Files:** Modify `package.json` scripts only, `public/index.html` cache tags, `deploy/release-from-github.cjs`, `tests/release-from-github.test.js`, `VIDEO_UPLOAD_STANDARD.md`, `DEPLOYMENT.md`; add targeted integration tests if Task1/2 leave a real boundary gap. Do not change GitHub workflow or dependency lock.
**Consumes:** approved Task1/Task2 implementations and test reports; existing runtime/static release executors.
**Produces:** tests wired into existing CI media checks, cache version `20261031-unified-upload1`, fail-closed release photo-idle guard, updated protocol docs.

- [ ] Add failing release tests: a `.project-` photo temporary file blocks release even when SQL has0active jobs; clean directory allows normal validation; no cleanup of the temporary file. Implement a reviewed exported helper called by idle() before and after stop, preserving existing locks/hashes/snapshot/rollback checks.
- [ ] Wire new tests and helper syntax into existing npm scripts without modifying dependencies, package-lock, initDb or workflow files; bump only H5 index app/styles cache tags.
- [ ] Run full existing checks with FFmpeg available in Ubuntu CI (identity,media,concurrency,large-video,SSO); locally run syntax and all non-FFmpeg fixtures, reporting environment-specific tool absence honestly. Run browser mixed40 synthetic verification and real media regression in an isolated environment.
- [ ] Document photo/video paths, resumable files vs browser File-object limits, slow-network timeouts, duplicate receipts and per-task controls; update exact release baseline and new guard.
- [ ] Self-review, commit only Task3 files and report to controller for independent task review; controller obtains whole-branch security/concurrency review before PR/merge.

## Finish and deployment (controller)

- [ ] Confirm reviewed code and tests, push PR, attach it to this chat; merge only greenCI, then wait for exact main SHA Check success.
- [ ] Re-inventory runtime and legacy photo temps; prepare explicit manifests and backups using target GitHub source; dry-run then apply backend, then TOS/CDN static, preserving all business data. Never git pull into runtime.
- [ ] Readback code and static hashes, health, existing account permissions and share album; check committed batch media intact. Any synthetic real-upload check must use approved isolated test storage/data, not customer album.
- [ ] Report what shipped, evidence, any remaining user-device acceptance; do not claim bandwidth improvement without measurement. Archive only managed worktrees actually created for this task; preserve current task-specific clone and committed docs.
