const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DATA_DIR = path.join(ROOT, "data");
// 迁移源（首次启动若库为空则从这里导入历史数据）
const DB_FILE = path.join(DATA_DIR, "db.json");
const SITE_CONFIG_FILE = path.join(DATA_DIR, "site-config.json");
const SEED_ACTIVITIES_FILE = path.join(DATA_DIR, "seed-activities.json");

// ---- MySQL 连接配置（通过环境变量注入，见 systemd / .env）----
const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "silver",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "silver",
  charset: "utf8mb4",
  connectionLimit: 5,
  waitForConnections: true
};

const VALID_ROLES = ["admin", "operator", "viewer", "member"];
const VALID_ACTIVITY_STATUSES = ["published", "pending", "draft", "rejected"];
const VALID_CASE_STATUSES = ["published", "draft"];
const VALID_CASE_MEDIA_TYPES = ["image", "video", "document", "link"];
const VALID_PROJECT_STATUSES = ["published", "draft", "archived"];
const VALID_PROJECT_MEDIA_TYPES = ["image", "video"];
const AUDIT_ACTIONS = ["view", "download"];
const AUDIT_RESOURCE_TYPES = ["activity", "case", "activity_project_media", "case_media", "activity_sop"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".webm"];
const DOCUMENT_EXTS = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".txt"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const CASE_VIDEO_TOS_PREFIX = String(process.env.CASE_VIDEO_TOS_PREFIX || "silver-case-videos").replace(/^\/+|\/+$/g, "");
const CASE_VIDEO_PUBLIC_BASE = String(process.env.CASE_VIDEO_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${CASE_VIDEO_TOS_PREFIX}`).replace(/\/+$/g, "");
const CASE_IMAGE_TOS_PREFIX = String(process.env.CASE_IMAGE_TOS_PREFIX || "silver-images").replace(/^\/+|\/+$/g, "");
const CASE_IMAGE_PUBLIC_BASE = String(process.env.CASE_IMAGE_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${CASE_IMAGE_TOS_PREFIX}`).replace(/\/+$/g, "");
const CASE_DOCUMENT_TOS_PREFIX = String(process.env.CASE_DOCUMENT_TOS_PREFIX || "silver-case-documents").replace(/^\/+|\/+$/g, "");
const CASE_DOCUMENT_PUBLIC_BASE = String(process.env.CASE_DOCUMENT_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${CASE_DOCUMENT_TOS_PREFIX}`).replace(/\/+$/g, "");
const PROJECT_IMAGE_TOS_PREFIX = String(process.env.PROJECT_IMAGE_TOS_PREFIX || "silver-project-images").replace(/^\/+|\/+$/g, "");
const PROJECT_IMAGE_PUBLIC_BASE = String(process.env.PROJECT_IMAGE_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${PROJECT_IMAGE_TOS_PREFIX}`).replace(/\/+$/g, "");
const PROJECT_VIDEO_TOS_PREFIX = String(process.env.PROJECT_VIDEO_TOS_PREFIX || "silver-project-videos").replace(/^\/+|\/+$/g, "");
const PROJECT_VIDEO_PUBLIC_BASE = String(process.env.PROJECT_VIDEO_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${PROJECT_VIDEO_TOS_PREFIX}`).replace(/\/+$/g, "");
const PROJECT_DOCUMENT_TOS_PREFIX = String(process.env.PROJECT_DOCUMENT_TOS_PREFIX || "silver-project-documents").replace(/^\/+|\/+$/g, "");
const PROJECT_DOCUMENT_PUBLIC_BASE = String(process.env.PROJECT_DOCUMENT_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${PROJECT_DOCUMENT_TOS_PREFIX}`).replace(/\/+$/g, "");
const DEFAULT_TOS_ENV_FILES = ["/etc/itinerary-admin.env", "/opt/learning-upload/tos.env"];
const DEFAULT_TOS_SDK_PATH = "/opt/course-tob/node_modules/@volcengine/tos-sdk";
const PROJECT_VIDEO_PART_SIZE = 16 * 1024 * 1024;
const PROJECT_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROJECT_UPLOAD_COMPLETED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let _caseVideoTosClient = null;

const UPLOAD_IMAGE_EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function sessionCookie(value, maxAge) {
  return `silver_session=${encodeURIComponent(value || "")}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${maxAge}`;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function parseEnvFile(file) {
  try {
    const env = {};
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
      const raw = line.trim();
      if (!raw || raw.startsWith("#") || !raw.includes("=")) return;
      const idx = raw.indexOf("=");
      const key = raw.slice(0, idx).trim();
      let value = raw.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) env[key] = value;
    });
    return env;
  } catch {
    return {};
  }
}

function getTosConfig() {
  const fileEnv = DEFAULT_TOS_ENV_FILES.reduce((acc, file) => ({ ...acc, ...parseEnvFile(file) }), {});
  const env = { ...fileEnv, ...process.env };
  const required = ["TOS_ACCESS_KEY_ID", "TOS_SECRET_ACCESS_KEY", "TOS_BUCKET", "TOS_ENDPOINT"];
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error("TOS配置缺失");
  return {
    accessKeyId: env.TOS_ACCESS_KEY_ID,
    accessKeySecret: env.TOS_SECRET_ACCESS_KEY,
    bucket: env.TOS_BUCKET,
    region: env.TOS_REGION || "cn-beijing",
    endpoint: env.TOS_ENDPOINT
  };
}

function getCaseVideoTosClient() {
  if (_caseVideoTosClient) return _caseVideoTosClient;
  let TosClient;
  let lastError;
  const sdkCandidates = [...new Set([
    process.env.TOS_SDK_PATH,
    "@volcengine/tos-sdk",
    DEFAULT_TOS_SDK_PATH
  ].filter(Boolean))];
  for (const sdkPath of sdkCandidates) {
    try {
      ({ TosClient } = require(sdkPath));
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!TosClient) throw lastError || new Error("TOS SDK加载失败");
  const config = getTosConfig();
  _caseVideoTosClient = { client: new TosClient(config), bucket: config.bucket };
  return _caseVideoTosClient;
}

function projectVideoTosObject(filename) {
  return {
    key: `${PROJECT_VIDEO_TOS_PREFIX}/${filename}`,
    url: `${PROJECT_VIDEO_PUBLIC_BASE}/${encodeURIComponent(filename)}`
  };
}

function unwrapTosResult(value) {
  return value && value.data && typeof value.data === "object" ? value.data : value;
}

function tosContentLength(value) {
  const data = unwrapTosResult(value) || {};
  const candidates = [
    data["content-length"],
    data.contentLength,
    data.ContentLength,
    value && value.headers && value.headers["content-length"]
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function assertTosObjectSize(headResult, expectedSize) {
  const actualSize = tosContentLength(headResult);
  if (actualSize === null) throw new Error("TOS未返回对象大小，无法完成上传校验");
  if (actualSize !== Number(expectedSize)) {
    throw new Error(`TOS对象大小校验失败（实际${actualSize}字节，应为${Number(expectedSize)}字节）`);
  }
  return actualSize;
}

async function readProjectUploadSession(sessionId) {
  const [[row]] = await pool.query("SELECT * FROM project_upload_sessions WHERE id = ?", [sessionId]);
  return row || null;
}

async function updateProjectUploadSession(sessionId, fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  values.push(sessionId);
  await pool.query(`UPDATE project_upload_sessions SET ${assignments}, updated_at = ? WHERE id = ?`, [
    ...values.slice(0, -1),
    now(),
    sessionId
  ]);
}

async function cleanupStaleProjectUploadSessions() {
  const cutoff = new Date(Date.now() - PROJECT_UPLOAD_SESSION_TTL_MS).toISOString();
  const [rows] = await pool.query(
    "SELECT id, object_key, upload_id FROM project_upload_sessions WHERE status IN ('uploading', 'failed') AND updated_at < ? LIMIT 50",
    [cutoff]
  );
  if (rows.length) {
    const { client, bucket } = getCaseVideoTosClient();
    for (const row of rows) {
      await client.abortMultipartUpload({ bucket, key: row.object_key, uploadId: row.upload_id }).catch(() => {});
      await updateProjectUploadSession(row.id, { status: "aborted", error: "上传会话超时，已自动清理" }).catch(() => {});
    }
    console.log(`[project-upload-cleanup] 清理 ${rows.length} 个过期分片会话`);
  }
  const completedCutoff = new Date(Date.now() - PROJECT_UPLOAD_COMPLETED_SESSION_TTL_MS).toISOString();
  const [deleted] = await pool.query(
    "DELETE FROM project_upload_sessions WHERE status IN ('completed', 'aborted') AND updated_at < ? LIMIT 200",
    [completedCutoff]
  );
  if (deleted.affectedRows) console.log(`[project-upload-cleanup] 删除 ${deleted.affectedRows} 条历史上传会话记录`);
}

async function uploadCaseVideoToTos(localPath, filename, contentType) {
  const { client, bucket } = getCaseVideoTosClient();
  const key = `${CASE_VIDEO_TOS_PREFIX}/${filename}`;
  const stat = fs.statSync(localPath);
  await client.putObjectFromFile({
    bucket,
    key,
    filePath: localPath,
    contentLength: stat.size,
    contentType,
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "inline"
  });
  return `${CASE_VIDEO_PUBLIC_BASE}/${encodeURIComponent(filename)}`;
}

async function uploadImageBufferToTos(buffer, filename, contentType) {
  const tmp = path.join(UPLOAD_DIR, `.tos-${filename}`);
  fs.writeFileSync(tmp, buffer);
  try {
    const { client, bucket } = getCaseVideoTosClient();
    const key = `${CASE_IMAGE_TOS_PREFIX}/${filename}`;
    await client.putObjectFromFile({
      bucket,
      key,
      filePath: tmp,
      contentLength: buffer.length,
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: "inline"
    });
    return `${CASE_IMAGE_PUBLIC_BASE}/${encodeURIComponent(filename)}`;
  } finally {
    fs.unlink(tmp, () => {});
  }
}

async function uploadImageFileToTos(localPath, filename, contentType) {
  const { client, bucket } = getCaseVideoTosClient();
  const key = `${CASE_IMAGE_TOS_PREFIX}/${filename}`;
  const stat = fs.statSync(localPath);
  await client.putObjectFromFile({
    bucket,
    key,
    filePath: localPath,
    contentLength: stat.size,
    contentType,
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "inline"
  });
  return `${CASE_IMAGE_PUBLIC_BASE}/${encodeURIComponent(filename)}`;
}

function getUploadImageExt(req) {
  const u = new URL(req.url, "http://localhost");
  const ext = String(u.searchParams.get("ext") || "").toLowerCase().replace(/^\./, "");
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return ext === "jpeg" ? ".jpg" : `.${ext}`;
  const contentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
  return UPLOAD_IMAGE_EXT_BY_MIME[contentType] || "";
}

function getUploadImageContentType(req, ext) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
  if (UPLOAD_IMAGE_EXT_BY_MIME[contentType]) return contentType;
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isJsonRequest(req) {
  return /^application\/json\b/i.test(String(req.headers["content-type"] || ""));
}

async function uploadRawImageRequest(req, prefix) {
  const ext = getUploadImageExt(req);
  if (!ext) throw Object.assign(new Error("请上传 png、jpg、webp 或 gif 图片"), { statusCode: 400 });
  const filename = `${prefix}_${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
  const dest = path.join(UPLOAD_DIR, `.upload-${filename}`);
  const ws = fs.createWriteStream(dest);
  let size = 0;
  return new Promise((resolve, reject) => {
    req.on("data", chunk => { size += chunk.length; });
    req.pipe(ws);
    ws.on("finish", async () => {
      if (size === 0) {
        fs.unlink(dest, () => {});
        reject(Object.assign(new Error("未收到图片数据"), { statusCode: 400 }));
        return;
      }
      try {
        const url = await uploadImageFileToTos(dest, filename, getUploadImageContentType(req, ext));
        fs.unlink(dest, () => {});
        resolve({ url, size });
      } catch (error) {
        fs.unlink(dest, () => {});
        reject(error);
      }
    });
    ws.on("error", error => {
      fs.unlink(dest, () => {});
      reject(error);
    });
    req.on("error", error => {
      fs.unlink(dest, () => {});
      reject(error);
    });
  });
}

async function uploadJsonImageRequest(req, prefix) {
  const body = await parseBody(req, 256 * 1024 * 1024);
  const dataUrl = String(body.dataUrl || "");
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
  if (!match) throw Object.assign(new Error("请上传 png、jpg、webp 或 gif 图片"), { statusCode: 400 });
  const buffer = Buffer.from(match[2], "base64");
  const filename = `${prefix}_${Date.now()}-${crypto.randomBytes(5).toString("hex")}${UPLOAD_IMAGE_EXT_BY_MIME[match[1]]}`;
  const url = await uploadImageBufferToTos(buffer, filename, match[1]);
  return { url, size: buffer.length };
}

async function handleImageUpload(req, res, prefix) {
  try {
    const result = isJsonRequest(req) ? await uploadJsonImageRequest(req, prefix) : await uploadRawImageRequest(req, prefix);
    sendJson(res, 201, { ok: true, ...result, storage: "tos" });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      error: error.statusCode ? error.message : "图片已接收,但上传 TOS 失败：" + (error.message || "未知错误")
    });
  }
}

async function uploadCaseDocumentToTos(localPath, filename, contentType) {
  const { client, bucket } = getCaseVideoTosClient();
  const key = `${CASE_DOCUMENT_TOS_PREFIX}/${filename}`;
  const stat = fs.statSync(localPath);
  await client.putObjectFromFile({
    bucket,
    key,
    filePath: localPath,
    contentLength: stat.size,
    contentType,
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "inline"
  });
  return `${CASE_DOCUMENT_PUBLIC_BASE}/${encodeURIComponent(filename)}`;
}

async function uploadProjectFileToTos(localPath, filename, type, contentType) {
  const { client, bucket } = getCaseVideoTosClient();
  const map = {
    image: [PROJECT_IMAGE_TOS_PREFIX, PROJECT_IMAGE_PUBLIC_BASE],
    video: [PROJECT_VIDEO_TOS_PREFIX, PROJECT_VIDEO_PUBLIC_BASE]
  };
  const [prefix, publicBase] = map[type] || [];
  if (!prefix || !publicBase) throw new Error("活动相册仅支持图片和视频");
  const stat = fs.statSync(localPath);
  await client.putObjectFromFile({
    bucket,
    key: `${prefix}/${filename}`,
    filePath: localPath,
    contentLength: stat.size,
    contentType,
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "inline"
  });
  return `${publicBase}/${encodeURIComponent(filename)}`;
}

function projectTosObjectKey(url) {
  const source = String(url || "");
  const mappings = [
    [PROJECT_IMAGE_TOS_PREFIX, PROJECT_IMAGE_PUBLIC_BASE],
    [PROJECT_VIDEO_TOS_PREFIX, PROJECT_VIDEO_PUBLIC_BASE]
  ];
  for (const [prefix, publicBase] of mappings) {
    if (source.startsWith(`${publicBase}/`)) {
      const encodedName = source.slice(publicBase.length + 1).split(/[?#]/, 1)[0];
      if (encodedName) return `${prefix}/${decodeURIComponent(encodedName)}`;
    }
  }
  try {
    const pathname = new URL(source).pathname;
    for (const [prefix] of mappings) {
      const marker = `/${prefix}/`;
      const start = pathname.indexOf(marker);
      if (start >= 0) return decodeURIComponent(pathname.slice(start + 1));
    }
  } catch {}
  return "";
}

function projectDownloadFileName(project, media, index) {
  const key = projectTosObjectKey(media.url);
  const ext = path.extname(key).toLowerCase();
  const fallbackExt = media.type === "video" ? ".mp4" : ".jpg";
  return `activity-${safeFileName(project.id)}-${index}${ext || fallbackExt}`;
}

function projectDownloadUrl(project, media, index) {
  const key = projectTosObjectKey(media.url);
  if (!key) return media.url;
  const ext = path.extname(key).toLowerCase();
  const filename = projectDownloadFileName(project, media, index);
  const { client, bucket } = getCaseVideoTosClient();
  return client.getPreSignedUrl({
    bucket,
    key,
    method: "GET",
    expires: 900,
    response: {
      contentType: MIME_TYPES[ext] || (media.type === "video" ? "video/mp4" : "image/jpeg"),
      contentDisposition: `attachment; filename="${filename}"`
    }
  });
}

// =====================================================================
//  MySQL 数据层：内存缓存 + 写穿透
//  - read* 同步返回缓存（业务 handler 逻辑保持不变）
//  - write* 异步把缓存持久化到 MySQL（handler 内 await）
// =====================================================================
let pool;
let _cache = { users: [], activities: [], posts: [], cases: [], activityProjects: [] };
let _siteConfig = { heroTitle: "", heroDesc: "", featuredIds: [], banners: [] };
let _sessions = {};
let _persistedSnapshot = null;
let _writeQueue = Promise.resolve();

function snapshotDbCollections() {
  const clone = value => JSON.parse(JSON.stringify(value || []));
  return {
    users: clone(_cache.users),
    activities: clone(_cache.activities),
    posts: clone(_cache.posts),
    cases: clone(_cache.cases),
    activityProjects: clone(_cache.activityProjects)
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function initDb() {
  pool = mysql.createPool(DB_CONFIG);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(190) UNIQUE,
    role VARCHAR(32),
    status VARCHAR(32),
    doc JSON,
    created_at VARCHAR(40)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS activities (
    id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(32),
    city VARCHAR(190),
    category VARCHAR(190),
    sort_order INT,
    updated_at VARCHAR(40),
    created_at VARCHAR(40),
    doc JSON
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id VARCHAR(64) PRIMARY KEY,
    activity_id VARCHAR(64),
    status VARCHAR(32),
    created_at VARCHAR(40),
    doc JSON
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cases (
    id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(32),
    category VARCHAR(190),
    sort_order INT,
    created_at VARCHAR(40),
    doc JSON
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS activity_projects (
    id VARCHAR(64) PRIMARY KEY,
    owner_id VARCHAR(64),
    status VARCHAR(32),
    created_at VARCHAR(40),
    updated_at VARCHAR(40),
    doc JSON
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS site_config (
    k VARCHAR(64) PRIMARY KEY,
    v JSON
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(80) PRIMARY KEY,
    user_id VARCHAR(64),
    created_at VARCHAR(40),
    expires_at VARCHAR(40)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS project_upload_sessions (
    id VARCHAR(80) PRIMARY KEY,
    project_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    type VARCHAR(16) NOT NULL,
    ext VARCHAR(16) NOT NULL,
    title VARCHAR(255),
    filename VARCHAR(255) NOT NULL,
    object_key VARCHAR(512) NOT NULL,
    upload_id VARCHAR(255) NOT NULL,
    file_size BIGINT UNSIGNED NOT NULL,
    part_size INT UNSIGNED NOT NULL,
    part_count INT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL,
    media_url TEXT,
    error TEXT,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    INDEX idx_project_upload_sessions_project (project_id),
    INDEX idx_project_upload_sessions_status (status, updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(64) NULL,
    username VARCHAR(190) NOT NULL DEFAULT '',
    user_name VARCHAR(190) NOT NULL DEFAULT '',
    role VARCHAR(32) NOT NULL DEFAULT '',
    action VARCHAR(32) NOT NULL,
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(190) NOT NULL DEFAULT '',
    resource_title VARCHAR(255) NOT NULL DEFAULT '',
    media_index INT NULL,
    media_type VARCHAR(32) NOT NULL DEFAULT '',
    filename VARCHAR(255) NOT NULL DEFAULT '',
    outcome VARCHAR(16) NOT NULL DEFAULT 'success',
    status_code INT NULL,
    ip_address VARCHAR(64) NOT NULL DEFAULT '',
    user_agent VARCHAR(512) NOT NULL DEFAULT '',
    referer VARCHAR(512) NOT NULL DEFAULT '',
    detail JSON NULL,
    created_at VARCHAR(40) NOT NULL,
    INDEX idx_audit_created_at (created_at),
    INDEX idx_audit_user_created (user_id, created_at),
    INDEX idx_audit_action_created (action, created_at),
    INDEX idx_audit_resource (resource_type, resource_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await loadCache();
  if (stripProjectDocumentsFromCache()) {
    await persistDb();
    console.log("[migration] 已从活动交付相册移除文档素材");
  }

  // 首次启动：库为空则从备份 JSON 导入历史数据，否则种子默认管理员
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM users");
  if (c === 0) {
    await importFromJsonOrSeed();
  }
}

async function loadCache() {
  const [users] = await pool.query("SELECT doc FROM users");
  _cache.users = users.map(r => parseDoc(r.doc));
  const [acts] = await pool.query("SELECT doc FROM activities");
  _cache.activities = acts.map(r => parseDoc(r.doc));
  const [posts] = await pool.query("SELECT doc FROM posts");
  _cache.posts = posts.map(r => parseDoc(r.doc));
  const [cases] = await pool.query("SELECT doc FROM cases");
  _cache.cases = cases.map(r => parseDoc(r.doc));
  const [projects] = await pool.query("SELECT doc FROM activity_projects");
  _cache.activityProjects = projects.map(r => parseDoc(r.doc));
  const [scRows] = await pool.query("SELECT k, v FROM site_config");
  const sc = { heroTitle: "", heroDesc: "", featuredIds: [], banners: [] };
  scRows.forEach(r => { sc[r.k] = parseDoc(r.v); });
  _siteConfig = sc;
  const [ss] = await pool.query("SELECT * FROM sessions");
  _sessions = {};
  ss.forEach(r => { _sessions[r.token] = { userId: r.user_id, createdAt: r.created_at, expiresAt: r.expires_at }; });
  _persistedSnapshot = snapshotDbCollections();
}

function parseDoc(v) {
  if (v == null) return v;
  if (typeof v === "object") return v;       // mysql2 已自动解析 JSON 列
  try { return JSON.parse(v); } catch { return v; }
}

async function importFromJsonOrSeed() {
  const fileDb = readJson(DB_FILE, null);
  if (fileDb && Array.isArray(fileDb.users) && fileDb.users.length) {
    console.log("[migrate] 检测到 data/db.json，导入历史数据 ...");
    _cache = {
      users: fileDb.users || [],
      activities: fileDb.activities || [],
      posts: fileDb.posts || [],
      cases: fileDb.cases || [],
      activityProjects: fileDb.activityProjects || []
    };
    const fileSc = readJson(SITE_CONFIG_FILE, null);
    if (fileSc) _siteConfig = { heroTitle: "", heroDesc: "", featuredIds: [], banners: [], ...fileSc };
    await persistDb();
    await persistSiteConfig();
    console.log(`[migrate] 完成：users=${_cache.users.length} activities=${_cache.activities.length} posts=${_cache.posts.length}`);
  } else {
    console.log("[seed] 库为空且无备份文件，写入默认管理员 admin/admin123");
    const salt = "demo-admin";
    _cache.users = [{
      id: "u_admin", username: "admin", name: "总部管理员", role: "admin",
      status: "active", canDownload: true, salt,
      passwordHash: hashPassword("admin123", salt), createdAt: now()
    }];
    _cache.activities = readJson(SEED_ACTIVITIES_FILE, []);
    _cache.activityProjects = [];
    await persistDb();
  }
}

async function persistDb() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const previous = _persistedSnapshot;
    const syncCollection = async (name, table, rows, removeSql, upsertSql, values) => {
      const currentRows = rows || [];
      const ids = currentRows.map(row => row.id);
      await conn.query(`DELETE FROM ${table} ${notInClause(ids)}`, ids.length ? ids : []);
      const previousRows = previous && previous[name] ? previous[name] : null;
      const previousJson = new Map((previousRows || []).map(row => [row.id, stableSerialize(row)]));
      for (const row of currentRows) {
        if (previousRows && previousJson.get(row.id) === stableSerialize(row)) continue;
        await conn.query(upsertSql, values(row));
      }
    };
    await syncCollection(
      "users", "users", _cache.users,
      null,
      `INSERT INTO users (id, username, role, status, doc, created_at) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE username=VALUES(username), role=VALUES(role), status=VALUES(status), doc=VALUES(doc), created_at=VALUES(created_at)`,
      u => [u.id, u.username, u.role, u.status, JSON.stringify(u), u.createdAt || now()]
    );
    await syncCollection(
      "activities", "activities", _cache.activities,
      null,
      `INSERT INTO activities (id, status, city, category, sort_order, updated_at, created_at, doc) VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), city=VALUES(city), category=VALUES(category), sort_order=VALUES(sort_order), updated_at=VALUES(updated_at), created_at=VALUES(created_at), doc=VALUES(doc)`,
      a => [a.id, a.status || "", a.city || "", a.category || "", Number(a.sortOrder || 9999), a.updatedAt || "", a.createdAt || "", JSON.stringify(a)]
    );
    await syncCollection(
      "posts", "posts", _cache.posts,
      null,
      `INSERT INTO posts (id, activity_id, status, created_at, doc) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE activity_id=VALUES(activity_id), status=VALUES(status), created_at=VALUES(created_at), doc=VALUES(doc)`,
      p => [p.id, p.activityId || "", p.status || "approved", p.createdAt || "", JSON.stringify(p)]
    );
    await syncCollection(
      "cases", "cases", _cache.cases,
      null,
      `INSERT INTO cases (id, status, category, sort_order, created_at, doc) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), category=VALUES(category), sort_order=VALUES(sort_order), created_at=VALUES(created_at), doc=VALUES(doc)`,
      c => [c.id, c.status || "", c.category || "", Number(c.sortOrder || 9999), c.createdAt || "", JSON.stringify(c)]
    );
    await syncCollection(
      "activityProjects", "activity_projects", _cache.activityProjects,
      null,
      `INSERT INTO activity_projects (id, owner_id, status, created_at, updated_at, doc) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE owner_id=VALUES(owner_id), status=VALUES(status), created_at=VALUES(created_at), updated_at=VALUES(updated_at), doc=VALUES(doc)`,
      p => [p.id, p.ownerId || "", p.status || "published", p.createdAt || "", p.updatedAt || "", JSON.stringify(p)]
    );
    await conn.commit();
    _persistedSnapshot = snapshotDbCollections();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

function notInClause(ids) {
  if (!ids.length) return "";
  return `WHERE id NOT IN (${ids.map(() => "?").join(",")})`;
}

async function persistSiteConfig() {
  for (const k of Object.keys(_siteConfig)) {
    await pool.query(
      `INSERT INTO site_config (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v=VALUES(v)`,
      [k, JSON.stringify(_siteConfig[k])]
    );
  }
}

async function persistSessions() {
  await pool.query("DELETE FROM sessions");
  for (const token of Object.keys(_sessions)) {
    const s = _sessions[token];
    await pool.query(
      `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
      [token, s.userId, s.createdAt, s.expiresAt]
    );
  }
}

// 与原文件保持同名接口，业务 handler 不变
function readDb() { return _cache; }
async function writeDb() {
  const run = _writeQueue.then(() => persistDb());
  _writeQueue = run.catch(() => {});
  return run;
}
function readSiteConfig() { return _siteConfig; }
async function writeSiteConfig(c) { _siteConfig = c; await persistSiteConfig(); }
function readSessions() { return _sessions; }
async function writeSessions(s) { _sessions = s; await persistSessions(); }

// =====================================================================

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function parseBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function getCookieToken(req) {
  const cookie = req.headers.cookie || "";
  const hit = cookie.split(";").map(x => x.trim()).find(x => x.startsWith("silver_session="));
  return hit ? decodeURIComponent(hit.split("=")[1]) : "";
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    status: user.status,
    canDownload: true
  };
}

function getAuthedUser(req) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = bearer || getCookieToken(req);
  if (!token) return null;
  const sessions = readSessions();
  const session = sessions[token];
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  const db = readDb();
  const user = db.users.find(x => x.id === session.userId && x.status === "active");
  return user || null;
}

function requireRole(req, res, roles) {
  const user = getAuthedUser(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录" });
    return null;
  }
  if (roles && !roles.includes(user.role)) {
    sendJson(res, 403, { error: "当前账号没有操作权限" });
    return null;
  }
  return user;
}

function auditText(value, max = 255) {
  return cleanString(value).slice(0, max);
}

function requestIp(req) {
  const forwarded = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "";
  const value = String(forwarded || req.socket?.remoteAddress || "").split(",")[0].trim();
  return value.replace(/^::ffff:/, "").slice(0, 64);
}

function auditMediaFilename(media, index) {
  const explicit = auditText(media?.title || media?.name, 255);
  if (explicit) return explicit;
  const rawUrl = String(media?.url || "").split("?")[0].split("#")[0];
  const basename = rawUrl ? path.basename(rawUrl) : "";
  return auditText(basename || `${media?.type === "video" ? "视频" : "图片"} #${Number(index) + 1}`, 255);
}

async function recordAuditLog(req, input = {}, actor) {
  const user = actor === undefined ? getAuthedUser(req) : actor;
  const action = auditText(input.action, 32);
  const resourceType = auditText(input.resourceType, 64);
  if (!AUDIT_ACTIONS.includes(action) || !AUDIT_RESOURCE_TYPES.includes(resourceType)) return false;
  try {
    await pool.query(
      `INSERT INTO audit_logs
       (user_id, username, user_name, role, action, resource_type, resource_id, resource_title,
        media_index, media_type, filename, outcome, status_code, ip_address, user_agent, referer, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        user?.id || null,
        auditText(user?.username || "游客", 190),
        auditText(user?.name || (user ? user.username : "游客"), 190),
        auditText(user?.role || "guest", 32),
        action,
        resourceType,
        auditText(input.resourceId, 190),
        auditText(input.resourceTitle, 255),
        Number.isInteger(Number(input.mediaIndex)) ? Number(input.mediaIndex) : null,
        auditText(input.mediaType, 32),
        auditText(input.filename, 255),
        auditText(input.outcome || "success", 16),
        Number.isInteger(Number(input.statusCode)) ? Number(input.statusCode) : null,
        requestIp(req),
        auditText(req.headers["user-agent"], 512),
        auditText(req.headers.referer || req.headers.referrer, 512),
        input.detail == null ? null : JSON.stringify(input.detail),
        now()
      ]
    );
    return true;
  } catch (error) {
    // 审计日志不能阻断正常观看/下载，但要保留服务端告警便于排查。
    console.error("[audit-log]", error && (error.stack || error.message || error));
    return false;
  }
}

async function loadProjectAuditSummary(projectId) {
  const [rows] = await pool.query(
    `SELECT media_index, action, COUNT(*) AS count
       FROM audit_logs
      WHERE resource_type = 'activity_project_media' AND resource_id = ?
      GROUP BY media_index, action`,
    [projectId]
  );
  return rows.map(row => ({
    mediaIndex: row.media_index,
    action: row.action,
    count: Number(row.count || 0)
  }));
}

async function resolveAuditViewEvent(body, db) {
  const resourceType = auditText(body.resourceType, 64);
  const resourceId = auditText(body.resourceId, 190);
  const hasMediaIndex = body.mediaIndex !== undefined && body.mediaIndex !== null && body.mediaIndex !== "";
  const mediaIndex = hasMediaIndex ? Number(body.mediaIndex) : null;
  if (!AUDIT_RESOURCE_TYPES.includes(resourceType) || !resourceId) return null;

  if (resourceType === "activity") {
    const activity = (db.activities || []).find(a => a.id === resourceId && a.status === "published");
    if (!activity) return null;
    return { resourceType, resourceId: activity.id, resourceTitle: activity.title, mediaIndex: null, mediaType: "activity", filename: "" };
  }

  if (resourceType === "case") {
    const item = (db.cases || []).find(c => c.id === resourceId && c.status === "published");
    if (!item) return null;
    return { resourceType, resourceId: item.id, resourceTitle: item.title, mediaIndex: null, mediaType: "case", filename: "" };
  }

  if (!Number.isInteger(mediaIndex) || mediaIndex < 0) return null;

  if (resourceType === "activity_project_media") {
    const project = (db.activityProjects || []).find(p => p.id === resourceId && p.status === "published" && p.shareEnabled !== false);
    const media = project && Array.isArray(project.media) ? project.media[mediaIndex] : null;
    if (!project || !media || !["image", "video"].includes(media.type) || !media.url) return null;
    return {
      resourceType,
      resourceId: project.id,
      resourceTitle: project.title,
      mediaIndex,
      mediaType: media.type,
      filename: auditMediaFilename(media, mediaIndex)
    };
  }

  if (resourceType === "case_media") {
    const item = (db.cases || []).find(c => c.id === resourceId && c.status === "published");
    const media = item && Array.isArray(item.media) ? item.media[mediaIndex] : null;
    if (!item || !media || !media.url) return null;
    return {
      resourceType,
      resourceId: item.id,
      resourceTitle: item.title,
      mediaIndex,
      mediaType: media.type,
      filename: auditMediaFilename(media, mediaIndex)
    };
  }

  if (resourceType === "activity_sop") {
    const activity = (db.activities || []).find(a => a.id === resourceId && a.status === "published");
    if (!activity) return null;
    return {
      resourceType,
      resourceId: activity.id,
      resourceTitle: activity.title,
      mediaIndex: null,
      mediaType: "sop",
      filename: auditText(`sop-${safeFileName(activity.id || activity.title)}.html`, 255)
    };
  }

  return null;
}

function normalizeActivity(input, existing = {}) {
  const listFrom = value => Array.isArray(value)
    ? value.map(x => String(x).trim()).filter(Boolean)
    : String(value || "").split("\n").map(x => x.trim()).filter(Boolean);
  const listOrExisting = (value, fallback = []) => {
    if (value === undefined) return fallback;
    return listFrom(value);
  };
  const schedule = Array.isArray(input.schedule)
    ? input.schedule.filter(x => x && (x.time || x.item)).map(x => ({ time: String(x.time || ""), item: String(x.item || "") }))
    : String(input.schedule || "").split("\n").map(line => {
      const [time, ...rest] = line.split(/\s*[-|｜]\s*/);
      return { time: (time || "").trim(), item: rest.join(" - ").trim() || (time || "").trim() };
    }).filter(x => x.item);
  const status = VALID_ACTIVITY_STATUSES.includes(input.status) ? input.status : (existing.status || "published");
  const downloadEnabled = input.downloadEnabled === undefined
    ? existing.downloadEnabled !== false
    : Boolean(input.downloadEnabled);

  return {
    ...existing,
    status,
    title: String(input.title || existing.title || "").trim(),
    city: String(input.city || existing.city || "").trim(),
    region: String(input.region || existing.region || input.city || existing.city || "").trim(),
    category: String(input.category || existing.category || "").trim(),
    activityType: String(input.activityType || input.type || existing.activityType || input.category || existing.category || "").trim(),
    price: String(input.price || existing.price || "").trim(),
    capacity: String(input.capacity || existing.capacity || "").trim(),
    duration: String(input.duration || existing.duration || "").trim(),
    location: String(input.location || existing.location || "").trim(),
    cover: String(input.cover || existing.cover || "").trim(),
    images: listOrExisting(input.images, existing.images || []),
    videos: listOrExisting(input.videos, existing.videos || []),
    references: listOrExisting(input.references, existing.references || []),
    tags: listOrExisting(input.tags, existing.tags || []),
    intro: String(input.intro || existing.intro || "").trim(),
    highlights: listOrExisting(input.highlights, existing.highlights || []),
    schedule: input.schedule === undefined ? (existing.schedule || []) : schedule,
    plan: {
      target: String(input.plan?.target || input.target || existing.plan?.target || "").trim(),
      materials: String(input.plan?.materials || input.materials || existing.plan?.materials || "").trim(),
      staffing: String(input.plan?.staffing || input.staffing || existing.plan?.staffing || "").trim(),
      conversion: String(input.plan?.conversion || input.conversion || existing.plan?.conversion || "").trim(),
      risk: String(input.plan?.risk || input.risk || existing.plan?.risk || "").trim()
    },
    downloadEnabled,
    reviewNote: String(input.reviewNote || existing.reviewNote || "").trim(),
    contact: String(input.contact || existing.contact || "").trim(),
    updatedAt: now()
  };
}

function cleanString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function normalizePublicPath(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  if (raw.startsWith("data:")) return "";
  if (raw.startsWith("uploads/")) return `/uploads/${raw.slice("uploads/".length)}`;
  if (raw.startsWith("assets/")) return `/assets/${raw.slice("assets/".length)}`;
  if (raw.startsWith("/silver-api/uploads/")) return `/uploads/${raw.slice("/silver-api/uploads/".length)}`;
  if (raw.startsWith("/silver-uploads/")) return `/uploads/${raw.slice("/silver-uploads/".length)}`;
  if (raw.startsWith("/uploads/") || raw.startsWith("/assets/")) return raw;
  if (!/^https?:\/\//i.test(raw)) return raw.startsWith("/") ? "" : raw;

  try {
    const parsed = new URL(raw);
    if (parsed.pathname.startsWith("/silver-api/uploads/")) {
      return `/uploads/${parsed.pathname.slice("/silver-api/uploads/".length)}`;
    }
    if (parsed.pathname.startsWith("/silver-uploads/")) {
      return `/uploads/${parsed.pathname.slice("/silver-uploads/".length)}`;
    }
    if (parsed.hostname === "proj2.likeduoduiyi.cn" && parsed.pathname.startsWith("/silver/assets/")) {
      return `/assets/${parsed.pathname.slice("/silver/assets/".length)}`;
    }
    return raw;
  } catch {
    return "";
  }
}

function hashFileSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function inferCaseMediaType(item, url) {
  const explicit = cleanString(item && item.type).toLowerCase();
  if (VALID_CASE_MEDIA_TYPES.includes(explicit)) return explicit;
  const cleanUrl = String(url || "").split("?")[0].split("#")[0];
  const ext = path.extname(cleanUrl).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (DOCUMENT_EXTS.includes(ext)) return "document";
  if (/^https?:\/\//i.test(cleanUrl)) return "link";
  return "image";
}

function normalizeCaseMedia(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.map(item => {
    const raw = typeof item === "string" ? { url: item } : (item && typeof item === "object" ? item : {});
    const url = normalizePublicPath(raw.url || raw.href || raw.src);
    if (!url) return null;
    const type = inferCaseMediaType(raw, url);
    if ((type === "link" || /^https?:\/\//i.test(url)) && !/^https?:\/\//i.test(url) && type === "link") return null;
    const key = `${type}:${url}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const media = {
      type,
      url,
      title: cleanString(raw.title || raw.name),
      caption: cleanString(raw.caption || raw.desc || raw.description)
    };
    const poster = normalizePublicPath(raw.poster || raw.cover);
    if (poster) media.poster = poster;
    for (const field of ["thumbnailUrl", "videoThumbnail"]) {
      const thumbnail = normalizePublicPath(raw[field]);
      if (thumbnail) media[field] = thumbnail;
    }
    const size = Number(raw.size || 0);
    if (Number.isFinite(size) && size > 0) media.size = size;
    if (raw.createdAt) media.createdAt = cleanString(raw.createdAt);
    return media;
  }).filter(Boolean);
}

function normalizeCase(input = {}, existing = {}) {
  const media = input.media === undefined ? normalizeCaseMedia(existing.media || []) : normalizeCaseMedia(input.media);
  const firstImage = media.find(m => m.type === "image");
  const cover = normalizePublicPath(input.cover !== undefined ? input.cover : existing.cover) || (firstImage && firstImage.url) || "";
  const sortRaw = input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder;
  const sortOrder = Number.isFinite(Number(sortRaw)) ? Number(sortRaw) : 9999;
  const statusRaw = cleanString(input.status, existing.status || "published").toLowerCase();
  const dateSource = input.dateLabel !== undefined ? input.dateLabel : (input.date !== undefined ? input.date : undefined);
  return {
    id: existing.id || input.id || createId("case"),
    title: cleanString(input.title, existing.title || ""),
    category: cleanString(input.category, existing.category || ""),
    description: cleanString(input.description, existing.description || ""),
    city: cleanString(input.city, existing.city || ""),
    dateLabel: cleanString(dateSource, existing.dateLabel || ""),
    cover,
    media,
    sortOrder,
    status: VALID_CASE_STATUSES.includes(statusRaw) ? statusRaw : "published",
    createdBy: cleanString(input.createdBy, existing.createdBy || ""),
    sourceProjectId: cleanString(input.sourceProjectId, existing.sourceProjectId || ""),
    createdAt: existing.createdAt || input.createdAt || now(),
    updatedAt: input.updatedAt || existing.updatedAt || now()
  };
}

function sortCases(list) {
  return [...(list || [])].sort((a, b) =>
    (Number(a.sortOrder || 9999) - Number(b.sortOrder || 9999)) ||
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

function caseCategories(list) {
  return [...new Set((list || []).map(c => c.category).filter(Boolean))];
}

function publicCase(c) {
  const { createdBy, ...rest } = normalizeCase(c, c);
  return rest;
}

function normalizeProjectMedia(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.map(item => {
    const raw = item && typeof item === "object" ? item : {};
    const type = VALID_PROJECT_MEDIA_TYPES.includes(cleanString(raw.type).toLowerCase())
      ? cleanString(raw.type).toLowerCase() : "";
    const url = cleanString(raw.url);
    if (!type || !/^https?:\/\//i.test(url)) return null;
    const fingerprint = cleanString(raw.fingerprint || raw.sha256 || raw.hash);
    const key = fingerprint ? `${type}:${fingerprint}` : `${type}:${url}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const media = {
      type,
      url,
      title: cleanString(raw.title || raw.name),
      caption: cleanString(raw.caption || raw.description),
      createdAt: cleanString(raw.createdAt) || now()
    };
    if (fingerprint) media.fingerprint = fingerprint;
    const size = Number(raw.size || 0);
    if (Number.isFinite(size) && size > 0) media.size = size;
    return media;
  }).filter(Boolean);
}

function normalizeActivityProject(input = {}, existing = {}) {
  const statusRaw = cleanString(input.status, existing.status || "published").toLowerCase();
  const media = input.media === undefined
    ? normalizeProjectMedia(existing.media || [])
    : normalizeProjectMedia(input.media);
  return {
    id: existing.id || input.id || createId("project"),
    title: cleanString(input.title, existing.title || "未命名活动相册"),
    activityId: cleanString(input.activityId, existing.activityId || ""),
    ownerId: cleanString(input.ownerId, existing.ownerId || ""),
    ownerName: cleanString(input.ownerName, existing.ownerName || ""),
    city: cleanString(input.city, existing.city || ""),
    dateLabel: cleanString(input.dateLabel, existing.dateLabel || ""),
    description: cleanString(input.description, existing.description || ""),
    cover: cleanString(input.cover, existing.cover || (media.find(m => m.type === "image") || {}).url || ""),
    media,
    status: VALID_PROJECT_STATUSES.includes(statusRaw) ? statusRaw : "published",
    shareEnabled: input.shareEnabled === undefined ? existing.shareEnabled !== false : Boolean(input.shareEnabled),
    sourceCaseId: cleanString(input.sourceCaseId, existing.sourceCaseId || ""),
    createdAt: existing.createdAt || input.createdAt || now(),
    updatedAt: input.updatedAt || now()
  };
}

function stripProjectDocumentsFromCache() {
  let changed = false;
  _cache.activityProjects = (_cache.activityProjects || []).map(project => {
    const next = normalizeActivityProject(project, project);
    if (stableSerialize(next.media) !== stableSerialize(project.media || [])) changed = true;
    return next;
  });
  return changed;
}

function projectMediaDuplicate(media, fingerprint, size) {
  const targetSize = Number(size) || 0;
  return (media || []).find(item => {
    if (!item || !item.url) return false;
    if (fingerprint && item.fingerprint && item.fingerprint === fingerprint) return true;
    return targetSize > 0 && Number(item.size) > 0 && Number(item.size) === targetSize;
  }) || null;
}

function projectCanManage(user, project) {
  return Boolean(user && project && (user.role === "admin" || user.role === "operator" || project.ownerId === user.id));
}

function publicProject(project, db, options = {}) {
  const item = normalizeActivityProject(project, project);
  const { ownerId, ownerName, ...safe } = item;
  const activity = (db.activities || []).find(a => a.id === item.activityId);
  const result = {
    ...safe,
    activityTitle: activity?.title || "",
    activityCategory: activity?.category || ""
  };
  if (options.includeOwner) {
    const owner = (db.users || []).find(user => user.id === ownerId);
    result.ownerName = owner?.name || owner?.username || ownerName || "未标注主理人";
  }
  return result;
}

function resolveLocalMediaPath(url) {
  const rel = normalizePublicPath(url);
  if (!rel || /^https?:\/\//i.test(rel)) return { remote: rel || "" };
  let baseDir = null;
  let subPath = "";
  if (rel.startsWith("/uploads/")) {
    baseDir = UPLOAD_DIR;
    subPath = rel.slice("/uploads/".length);
  } else if (rel.startsWith("/assets/")) {
    baseDir = path.join(ROOT, "public", "assets");
    subPath = rel.slice("/assets/".length);
  } else {
    return { error: "非法素材路径" };
  }
  const full = path.normalize(path.join(baseDir, subPath));
  const root = path.normalize(baseDir + path.sep);
  if (!full.startsWith(root)) return { error: "非法素材路径" };
  return { path: full };
}

function formatActivitySop(activity) {
  const list = values => (values || []).map((value, index) => `${index + 1}. ${value}`).join("\n") || "待补充";
  const schedule = (activity.schedule || []).map((row, index) => `${index + 1}. ${row.time || "待定"} - ${row.item || ""}`).join("\n") || "待补充";
  const plan = activity.plan || {};
  return [
    `活动SOP：${activity.title}`,
    "",
    `活动大类：${activity.category || "未填写"}`,
    `细分类型：${activity.activityType || "未填写"}`,
    `城市/地区：${activity.city || "未填写"} / ${activity.region || activity.city || "未填写"}`,
    `价格：${activity.price || "未填写"}`,
    `人数：${activity.capacity || "未填写"}`,
    `时长：${activity.duration || "未填写"}`,
    `地点：${activity.location || "未填写"}`,
    "",
    "一、活动简介",
    activity.intro || "待补充",
    "",
    "二、核心亮点",
    list(activity.highlights),
    "",
    "三、当日活动时间轴",
    schedule,
    "",
    "四、活动定位与转化目标",
    plan.target || "待补充",
    "",
    "五、所需物料",
    plan.materials || "待补充",
    "",
    "六、人员分工",
    plan.staffing || "待补充",
    "",
    "七、话术与转化承接",
    plan.conversion || "待补充",
    "",
    "八、注意事项与风险预案",
    plan.risk || "待补充",
    "",
    "九、图片/视频/参考资料",
    `图片：${(activity.images || []).join("；") || "待补充"}`,
    `视频：${(activity.videos || []).join("；") || "待补充"}`,
    `参考链接：${(activity.references || []).join("；") || "待补充"}`,
    "",
    "十、新手主理人提醒",
    "1. 活动前一天确认场地、人数、物料、老师和拍摄人员。",
    "2. 活动当天先做签到分组，再做破冰，避免用户到场后无序等待。",
    "3. 现场一定要沉淀照片、短视频、用户反馈和意向标签。",
    "4. 活动结束24小时内完成群内作品发布、私聊反馈和下一步邀约。",
    "5. 涉及食品、户外、交通、演出等场景时，提前确认资质、保险和安全预案。"
  ].join("\n");
}

function sopHtmlEsc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sopTextHtml(value) {
  const text = String(value == null || value === "" ? "待补充" : value);
  return sopHtmlEsc(text).replace(/\n/g, "<br>");
}

function formatActivitySopHtml(activity) {
  const plan = activity.plan || {};
  const list = values => {
    const arr = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!arr.length) return `<div class="empty">待补充</div>`;
    return `<ul>${arr.map(value => `<li>${sopHtmlEsc(value)}</li>`).join("")}</ul>`;
  };
  const infoItems = [
    ["活动大类", activity.category || "未填写"],
    ["细分类型", activity.activityType || "未填写"],
    ["城市/地区", `${activity.city || "未填写"} / ${activity.region || activity.city || "未填写"}`],
    ["参考价格", activity.price || "未填写"],
    ["人数规模", activity.capacity || "未填写"],
    ["活动时长", activity.duration || "未填写"],
    ["推荐地点", activity.location || "未填写"]
  ];
  const schedule = Array.isArray(activity.schedule) ? activity.schedule.filter(row => row && (row.time || row.item)) : [];
  const scheduleHtml = schedule.length
    ? schedule.map((row, index) => `
      <div class="timeline-item">
        <div class="timeline-time">${sopHtmlEsc(row.time || `节点${index + 1}`)}</div>
        <div class="timeline-copy">${sopHtmlEsc(row.item || "待补充")}</div>
      </div>`).join("")
    : `<div class="empty">待补充</div>`;
  const planCards = [
    ["活动定位", "01", plan.target],
    ["所需物料", "02", plan.materials],
    ["人员分工", "03", plan.staffing],
    ["话术与转化承接", "04", plan.conversion],
    ["注意事项与风险预案", "05", plan.risk]
  ].map(([title, no, content]) => `
    <section class="plan-card">
      <div class="card-head"><span>${no}</span><h2>${title}</h2></div>
      <div class="card-body">${sopTextHtml(content)}</div>
    </section>`).join("");
  const counts = [
    ["图片", (activity.images || []).length],
    ["视频", (activity.videos || []).length],
    ["参考链接", (activity.references || []).length]
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${sopHtmlEsc(activity.title || "活动SOP")} - 可视化SOP</title>
  <style>
    :root{--ink:#231f1b;--body:#514941;--muted:#8a8178;--line:#eadfd4;--paper:#fffaf4;--card:#fff;--accent:#c6532a;--accent2:#246b61;--gold:#b48a38}
    *{box-sizing:border-box}
    body{margin:0;background:#f6f1ea;color:var(--body);font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;line-height:1.72}
    .page{width:min(1120px,calc(100% - 40px));margin:0 auto;padding:30px 0 44px}
    .hero{background:linear-gradient(135deg,#2b241f 0%,#5d3425 54%,#b55a32 100%);color:#fff;border-radius:18px;padding:30px;position:relative;overflow:hidden}
    .hero:after{content:"";position:absolute;right:-80px;top:-120px;width:300px;height:300px;border:1px solid rgba(255,255,255,.22);border-radius:999px}
    .brand{font-size:13px;letter-spacing:.08em;opacity:.78;margin-bottom:14px}
    h1{position:relative;margin:0;font-size:32px;line-height:1.25;color:#fff}
    .subtitle{position:relative;margin:12px 0 0;font-size:15px;opacity:.88;max-width:760px}
    .info-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 0;position:relative}
    .info{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px 14px}
    .info label{display:block;font-size:12px;opacity:.72;margin-bottom:3px}.info strong{display:block;font-size:15px;color:#fff}
    .section{margin-top:18px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
    .section-title{display:flex;align-items:center;gap:10px;margin:0 0 14px;color:var(--ink);font-size:20px}
    .section-title span{width:8px;height:22px;border-radius:99px;background:var(--accent)}
    ul{margin:0;padding-left:22px}.empty{color:var(--muted)}
    .three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .stage{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--paper)}
    .stage b{display:block;color:var(--accent);margin-bottom:8px}
    .timeline{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .timeline-item{border:1px solid var(--line);border-radius:14px;padding:14px;background:#fff}
    .timeline-time{font-weight:800;color:var(--accent);font-size:15px;margin-bottom:6px}
    .timeline-copy{font-size:14px;color:var(--body)}
    .plan-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
    .plan-card{margin:0;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden}
    .plan-card:last-child{grid-column:1/-1}
    .card-head{display:flex;align-items:center;gap:12px;background:var(--paper);border-bottom:1px solid var(--line);padding:14px 16px}
    .card-head span{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;font-weight:800;font-size:13px}
    .card-head h2{margin:0;color:var(--ink);font-size:18px}.card-body{padding:16px;font-size:14px;white-space:normal}
    .media-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.media{padding:16px;border-radius:14px;border:1px solid var(--line);background:var(--paper)}
    .media strong{display:block;font-size:24px;color:var(--accent);line-height:1}.media span{font-size:13px;color:var(--muted)}
    .checklist{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.check{padding:12px 14px;background:var(--paper);border:1px solid var(--line);border-radius:12px}
    .footer{margin-top:18px;text-align:center;color:var(--muted);font-size:12px}
    @media (max-width:860px){.page{width:min(100% - 24px,1120px)}.hero{padding:22px}h1{font-size:26px}.info-grid,.timeline,.plan-grid,.three,.media-grid,.checklist{grid-template-columns:1fr}}
    @media print{body{background:#fff}.page{width:100%;padding:0}.hero,.section{break-inside:avoid;border-radius:0}.footer{display:none}}
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div class="brand">开开华彩 · 活动执行 SOP</div>
      <h1>${sopHtmlEsc(activity.title || "活动SOP")}</h1>
      <p class="subtitle">${sopHtmlEsc(activity.intro || "围绕活动前沟通、活动中执行、活动后转化复盘，形成可直接交给主理人落地的执行包。")}</p>
      <div class="info-grid">${infoItems.map(([label, value]) => `<div class="info"><label>${label}</label><strong>${sopHtmlEsc(value)}</strong></div>`).join("")}</div>
    </header>
    <section class="section">
      <h2 class="section-title"><span></span>活动亮点</h2>
      ${list(activity.highlights)}
    </section>
    <section class="section">
      <h2 class="section-title"><span></span>执行三阶段</h2>
      <div class="three">
        <div class="stage"><b>活动前</b>完成报名确认、客群标签、物料准备、场地动线、工作人员分工和活动提醒。</div>
        <div class="stage"><b>活动中</b>按时间轴控场，持续捕捉高光内容，重点照顾新客体验和可转化意向。</div>
        <div class="stage"><b>活动后</b>24小时内完成作品发布、私聊回访、群内互动、意向分层和下一步邀约。</div>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title"><span></span>当日活动时间轴</h2>
      <div class="timeline">${scheduleHtml}</div>
    </section>
    <section class="section">
      <h2 class="section-title"><span></span>标准化执行包</h2>
      <div class="plan-grid">${planCards}</div>
    </section>
    <section class="section">
      <h2 class="section-title"><span></span>素材沉淀</h2>
      <div class="media-grid">${counts.map(([label, count]) => `<div class="media"><strong>${count}</strong><span>${label}素材</span></div>`).join("")}</div>
    </section>
    <section class="section">
      <h2 class="section-title"><span></span>交付核查清单</h2>
      <div class="checklist">
        <div class="check">活动前一天确认场地、人数、老师、摄影与应急物料。</div>
        <div class="check">签到后先破冰分组，避免用户到场后无序等待。</div>
        <div class="check">现场沉淀照片、短视频、用户反馈和意向标签。</div>
        <div class="check">活动结束24小时内完成群内发布、私聊反馈和下一步邀约。</div>
      </div>
    </section>
    <div class="footer">开开华彩 · 活动 SOP 学习平台 · 可直接打印或另存为 PDF</div>
  </main>
</body>
</html>`;
}

// ---- DeepSeek 智能解析活动文案 ----
function getDeepseekConfig() {
  let key = process.env.DEEPSEEK_API_KEY || "";
  let base = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  let model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  if (!key) {
    // 复用 itinerary 项目已配置的 DeepSeek key（运行时读取，不复制到本项目）
    try {
      const cfg = JSON.parse(fs.readFileSync("/opt/itinerary-admin/data/store.json", "utf8")).ai_config || {};
      if (cfg.api_key) key = cfg.api_key;
      if (cfg.base_url) base = cfg.base_url;
    } catch {}
  }
  return { key, base, model };
}

async function parseActivityWithAI(text) {
  const { key, base, model } = getDeepseekConfig();
  if (!key) throw new Error("未配置 DeepSeek API Key");
  const sys = [
    "你是活动方案结构化助手。把用户提供的活动文案/流程，抽取成一个 JSON 对象。",
    "只输出 JSON，不要多余文字。字段如下（缺失就用空字符串或空数组，不要编造离谱内容）：",
    "title 标题, intro 一句话简介, city 城市, region 地区, category 活动大类, activityType 细分类型,",
    "price 参考价格, capacity 适合人数, duration 活动时长, location 推荐地点, contact 报名/咨询提示,",
    "highlights 亮点(字符串数组), tags 标签(字符串数组),",
    "schedule 当日活动时间轴(数组，每项 {time, item}),",
    "plan 活动执行包(对象 {target 活动定位与转化目标, materials 所需物料, staffing 人员分工, conversion 活动前/活动中/活动后话术与转化承接, risk 注意事项与风险预案})。"
  ].join("\n");
  const resp = await fetch(base.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: sys }, { role: "user", content: text }],
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  });
  if (!resp.ok) throw new Error("DeepSeek HTTP " + resp.status);
  const data = await resp.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "{}";
  let obj;
  try { obj = JSON.parse(content); }
  catch { const m = content.match(/\{[\s\S]*\}/); obj = m ? JSON.parse(m[0]) : {}; }
  const arr = v => Array.isArray(v)
    ? v.map(x => String(x).trim()).filter(Boolean)
    : (v ? String(v).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []);
  const plan = obj.plan || {};
  return {
    title: String(obj.title || "").trim(),
    intro: String(obj.intro || "").trim(),
    city: String(obj.city || "").trim(),
    region: String(obj.region || "").trim(),
    category: String(obj.category || "").trim(),
    activityType: String(obj.activityType || obj.type || "").trim(),
    price: String(obj.price || "").trim(),
    capacity: String(obj.capacity || "").trim(),
    duration: String(obj.duration || "").trim(),
    location: String(obj.location || "").trim(),
    contact: String(obj.contact || "").trim(),
    highlights: arr(obj.highlights),
    tags: arr(obj.tags),
    schedule: Array.isArray(obj.schedule)
      ? obj.schedule.map(x => ({ time: String((x && x.time) || "").trim(), item: String((x && x.item) || "").trim() })).filter(x => x.item || x.time)
      : [],
    plan: {
      target: String(plan.target || "").trim(),
      materials: String(plan.materials || "").trim(),
      staffing: String(plan.staffing || "").trim(),
      conversion: String(plan.conversion || "").trim(),
      risk: String(plan.risk || "").trim()
    }
  };
}

function safeFileName(value) {
  return String(value || "activity")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "activity";
}

function serveFile(res, filePath, req) {
  const ext = path.extname(filePath).toLowerCase();
  const isVideo = [".mp4", ".m4v", ".mov", ".webm"].includes(ext);
  if (isVideo) {
    // 视频走流式 + Range,支持拖进度条,避免整读内存
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return sendText(res, 404, "Not Found");
      const total = stat.size;
      const range = req && req.headers.range && String(req.headers.range).match(/bytes=(\d*)-(\d*)/);
      let start = 0, end = total - 1, status = 200;
      if (range && (range[1] || range[2])) {
        start = range[1] ? parseInt(range[1], 10) : Math.max(0, total - parseInt(range[2], 10));
        end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), total - 1) : end;
        if (isNaN(start) || start >= total) { res.writeHead(416, { "Content-Range": `bytes */${total}` }); return res.end(); }
        status = 206;
      }
      const headers = {
        "Content-Type": MIME_TYPES[ext],
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600"
      };
      if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      res.writeHead(status, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": [".html", ".css", ".js"].includes(ext) ? "no-cache" : "public, max-age=3600"
    });
    res.end(data);
  });
}

function safeStaticPath(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(baseDir, clean));
  if (!full.startsWith(baseDir)) return null;
  return full;
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    try {
      await pool.query("SELECT 1");
      return sendJson(res, 200, { ok: true, service: "silver", database: "ok", time: now() });
    } catch (error) {
      return sendJson(res, 503, { ok: false, service: "silver", database: "error", error: "数据库不可用" });
    }
  }

  if (req.method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(getAuthedUser(req)) });
    return;
  }

  // 前台观看埋点：允许游客记录为“游客”，登录用户关联到具体账号。
  if (req.method === "POST" && pathname === "/api/audit-events") {
    const body = await parseBody(req, 64 * 1024);
    if (body.action !== "view") return sendJson(res, 400, { error: "仅支持观看事件上报" });
    const event = await resolveAuditViewEvent(body, readDb());
    if (!event) return sendJson(res, 404, { error: "素材不存在或不可访问" });
    const logged = await recordAuditLog(req, { action: "view", ...event });
    return sendJson(res, 200, { ok: true, logged });
  }

  // 访问审计：只允许总部管理员查看，不把用户设备/IP等信息下发给普通账号。
  if (req.method === "GET" && pathname === "/api/admin/audit-logs") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const url = new URL(req.url, "http://localhost");
    const q = auditText(url.searchParams.get("q"), 120);
    const action = auditText(url.searchParams.get("action"), 32);
    const resourceType = auditText(url.searchParams.get("resourceType"), 64);
    const userId = auditText(url.searchParams.get("userId"), 64);
    const from = auditText(url.searchParams.get("from"), 40);
    const to = auditText(url.searchParams.get("to"), 40);
    const page = Math.max(1, Math.min(100000, Number(url.searchParams.get("page") || 1) || 1));
    const pageSize = Math.max(10, Math.min(100, Number(url.searchParams.get("pageSize") || 30) || 30));
    const where = [];
    const params = [];
    if (q) {
      where.push("CONCAT_WS(' ', username, user_name, resource_title, filename, ip_address) LIKE ?");
      params.push(`%${q}%`);
    }
    if (AUDIT_ACTIONS.includes(action)) { where.push("action = ?"); params.push(action); }
    if (AUDIT_RESOURCE_TYPES.includes(resourceType)) { where.push("resource_type = ?"); params.push(resourceType); }
    if (userId) { where.push("user_id = ?"); params.push(userId); }
    if (/^\d{4}-\d{2}-\d{2}T/.test(from)) { where.push("created_at >= ?"); params.push(from); }
    if (/^\d{4}-\d{2}-\d{2}T/.test(to)) { where.push("created_at <= ?"); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [summaryRows] = await pool.query(
      `SELECT user_id, username, user_name, role,
              SUM(action = 'view') AS view_count,
              SUM(action = 'download') AS download_count,
              COUNT(*) AS total_count
         FROM audit_logs ${whereSql}
        GROUP BY user_id, username, user_name, role
        ORDER BY total_count DESC, user_name ASC`,
      params
    );
    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`, params);
    const total = Number(countRow?.total || 0);
    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT id, user_id, username, user_name, role, action, resource_type, resource_id,
              resource_title, media_index, media_type, filename, outcome, status_code,
              ip_address, user_agent, referer, created_at
         FROM audit_logs ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?, ?`,
      [...params, offset, pageSize]
    );
    return sendJson(res, 200, {
      logs: rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        userName: row.user_name,
        role: row.role,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        resourceTitle: row.resource_title,
        mediaIndex: row.media_index,
        mediaType: row.media_type,
        filename: row.filename,
        outcome: row.outcome,
        statusCode: row.status_code,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        referer: row.referer,
        createdAt: row.created_at
      })),
      summaryByUser: summaryRows.map(row => ({
        userId: row.user_id,
        username: row.username,
        userName: row.user_name,
        role: row.role,
        viewCount: Number(row.view_count || 0),
        downloadCount: Number(row.download_count || 0),
        totalCount: Number(row.total_count || 0)
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/audit-summary") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const [rows] = await pool.query(
      `SELECT resource_type, resource_id, action, media_index, COUNT(*) AS count
         FROM audit_logs
        GROUP BY resource_type, resource_id, action, media_index`
    );
    return sendJson(res, 200, {
      summaries: rows.map(row => ({
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        mediaIndex: row.media_index,
        count: Number(row.count || 0)
      }))
    });
  }

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    const name = String(body.name || username).trim();
    if (!username || !password) {
      sendJson(res, 400, { error: "请填写账号和密码" });
      return;
    }
    if (password.length < 6) {
      sendJson(res, 400, { error: "密码至少6位" });
      return;
    }
    const db = readDb();
    if (db.users.some(x => x.username === username)) {
      sendJson(res, 409, { error: "该账号已被使用，请换一个" });
      return;
    }
    const salt = crypto.randomBytes(8).toString("hex");
    const newUser = {
      id: createId("u"),
      username,
      name,
      role: "member",
      status: "disabled",
      canDownload: false,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: now()
    };
    db.users.push(newUser);
    await writeDb(db);
    sendJson(res, 201, { ok: true, message: "申请已提交，请等待管理员开通后登录" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await parseBody(req);
    const db = readDb();
    const user = db.users.find(x => x.username === body.username && x.status === "active");
    if (!user || user.passwordHash !== hashPassword(String(body.password || ""), user.salt)) {
      sendJson(res, 401, { error: "账号或密码不正确" });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    const sessions = readSessions();
    sessions[token] = {
      userId: user.id,
      createdAt: now(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    await writeSessions(sessions);
    // 同时返回 Bearer token，兼容微信内置浏览器等无法稳定保存跨域 Cookie 的环境。
    // Cookie 仍然保留，桌面端和已有登录态无需改变。
    sendJson(res, 200, { user: publicUser(user), token }, {
      "Set-Cookie": sessionCookie(token, 7 * 24 * 60 * 60)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = getCookieToken(req);
    const sessions = readSessions();
    if (token) delete sessions[token];
    await writeSessions(sessions);
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": sessionCookie("", 0)
    });
    return;
  }

  // 轮播图 GET
  if (req.method === "GET" && pathname === "/api/banners") {
    const cfg = readSiteConfig();
    return sendJson(res, 200, { banners: cfg.banners || [] });
  }

  // 轮播图上传 POST
  if (req.method === "POST" && pathname === "/api/admin/banners/upload") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const cfg = readSiteConfig();
    cfg.banners = cfg.banners || [];
    if (cfg.banners.length >= 6) return sendJson(res, 400, { error: "最多6张轮播图" });
    try {
      const result = isJsonRequest(req) ? await uploadJsonImageRequest(req, "banner") : await uploadRawImageRequest(req, "banner");
      cfg.banners.push(result.url);
      await writeSiteConfig(cfg);
      return sendJson(res, 200, { ok: true, url: result.url, size: result.size, banners: cfg.banners, storage: "tos" });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, {
        error: error.statusCode ? error.message : "图片已接收,但上传 TOS 失败：" + (error.message || "未知错误")
      });
    }
  }

  // 轮播图删除 DELETE
  if (req.method === "POST" && pathname === "/api/admin/banners/delete") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const cfg = readSiteConfig();
    cfg.banners = (cfg.banners || []).filter(b => b !== body.url);
    await writeSiteConfig(cfg);
    return sendJson(res, 200, { ok: true, banners: cfg.banners });
  }

  // 留言列表 GET /api/posts?activityId=xxx
  if (req.method === "GET" && pathname === "/api/posts") {
    const u2 = new URL(req.url, "http://localhost");
    const aid = u2.searchParams.get("activityId") || "";
    const db = readDb();
    let viewer = null;
    try { viewer = getAuthedUser(req); } catch (e) {}
    const isAdmin = viewer && viewer.role === "admin";
    const vname = viewer ? (viewer.name || viewer.username || "") : "";
    const posts = (db.posts || []).filter(p => p.activityId === aid)
      .filter(p => isAdmin || (p.status || "approved") === "approved" || p.author === vname)
      .sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
    return sendJson(res, 200, { posts, isAdmin });
  }

  // 发布留言 POST /api/posts
  if (req.method === "POST" && pathname === "/api/posts") {
    const user = requireRole(req, res, ["admin", "operator", "member", "city"]);
    if (!user) return;
    const body = await parseBody(req, 24 * 1024 * 1024);
    const text = String(body.content || "").trim();
    if (!text) return sendJson(res, 400, { error: "内容不能为空" });
    if (text.length > 2000) return sendJson(res, 400, { error: "内容不能超过2000字" });
    const imgs = [];
    if (Array.isArray(body.images)) {
      for (const dataUrl of body.images.slice(0, 3)) {
        const existing = normalizePublicPath(dataUrl);
        if (/^https?:\/\//i.test(existing) || existing.startsWith("/uploads/")) {
          imgs.push(existing);
          continue;
        }
        const m = String(dataUrl).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
        if (!m) continue;
        const buf = Buffer.from(m[2], "base64");
        const fname = "post_" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + UPLOAD_IMAGE_EXT_BY_MIME[m[1]];
        try {
          imgs.push(await uploadImageBufferToTos(buf, fname, m[1]));
        } catch (error) {
          console.error("[post-image-tos]", error && (error.stack || error.message || error));
        }
      }
    }
    const db = readDb();
    db.posts = db.posts || [];
    const post = {
      id: "post_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
      activityId: String(body.activityId || ""),
      author: user.name || user.username || "用户",
      role: user.role === "admin" ? "总部管理员" : (user.role === "city" ? "城市主理人" : "学习用户"),
      content: text,
      images: imgs,
      likes: 0,
      status: user.role === "admin" ? "approved" : "pending",
      createdAt: new Date().toISOString()
    };
    db.posts.push(post);
    await writeDb(db);
    return sendJson(res, 200, { ok: true, post });
  }

  // 管理员留言列表 GET /api/admin/posts
  if (req.method === "GET" && pathname === "/api/admin/posts") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    const titleMap = {};
    (db.activities || []).forEach(a => { titleMap[a.id] = a.title; });
    const posts = (db.posts || []).map(p => ({ ...p, activityTitle: titleMap[p.activityId] || p.activityId }))
      .sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
    return sendJson(res, 200, { posts });
  }

  // 审核通过 POST /api/admin/posts/approve（仅admin）
  if (req.method === "POST" && pathname === "/api/admin/posts/approve") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    const p = (db.posts || []).find(x => x.id === body.id);
    if (!p) return sendJson(res, 404, { error: "留言不存在" });
    p.status = "approved";
    await writeDb(db);
    return sendJson(res, 200, { ok: true });
  }

  // 删除留言 POST /api/admin/posts/delete（仅admin）
  if (req.method === "POST" && pathname === "/api/admin/posts/delete") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    db.posts = (db.posts || []).filter(p => p.id !== body.id);
    await writeDb(db);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/site-config") { return sendJson(res, 200, { config: readSiteConfig() }); }
  if (req.method === "POST" && pathname === "/api/admin/site-config") {
    const u = requireRole(req, res, ["admin"]); if (!u) return;
    const b = await parseBody(req); const c = readSiteConfig();
    if (b.heroTitle !== undefined) c.heroTitle = b.heroTitle;
    if (b.heroDesc !== undefined) c.heroDesc = b.heroDesc;
    if (b.featuredIds !== undefined) c.featuredIds = b.featuredIds;
    await writeSiteConfig(c); return sendJson(res, 200, { ok: true, config: c });
  }
  // 未登录用户不下发 SOP 执行方案(plan),前端据 planLocked 打码引导登录
  function redactPlanForGuest(req, activity) {
    let viewer = null;
    try { viewer = getAuthedUser(req); } catch (e) {}
    if (viewer) return activity;
    const { plan, ...rest } = activity;
    return { ...rest, planLocked: true };
  }

  if (req.method === "GET" && pathname === "/api/public/activities") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const city = (url.searchParams.get("city") || "").trim();
    const category = (url.searchParams.get("category") || "").trim();
    const db = readDb();
    const activities = db.activities
      .filter(x => x.status === "published")
      .filter(x => !city || x.city === city)
      .filter(x => !category || x.category === category)
      .filter(x => !q || [x.title, x.city, x.region, x.category, x.activityType, x.intro, ...(x.tags || [])].join(" ").toLowerCase().includes(q))
      .sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    sendJson(res, 200, {
      activities: activities.map(a => redactPlanForGuest(req, a)),
      cities: [...new Set(db.activities.filter(x => x.status === "published").map(x => x.city).filter(Boolean))],
      categories: [...new Set(db.activities.filter(x => x.status === "published").map(x => x.category).filter(Boolean))]
    });
    return;
  }

  const publicDetail = pathname.match(/^\/api\/public\/activities\/([^/]+)$/);
  if (req.method === "GET" && publicDetail) {
    const db = readDb();
    const activity = db.activities.find(x => x.id === publicDetail[1] && x.status === "published");
    if (!activity) {
      sendJson(res, 404, { error: "活动不存在或未发布" });
      return;
    }
    sendJson(res, 200, { activity: redactPlanForGuest(req, activity) });
    return;
  }

  const publicDownload = pathname.match(/^\/api\/public\/activities\/([^/]+)\/download$/);
  if (req.method === "GET" && publicDownload) {
    const user = requireRole(req, res, VALID_ROLES);
    if (!user) return;
    const db = readDb();
    const activity = db.activities.find(x => x.id === publicDownload[1] && x.status === "published");
    if (!activity) {
      sendJson(res, 404, { error: "活动不存在或未发布" });
      return;
    }
    if (activity.downloadEnabled === false) {
      sendJson(res, 403, { error: "该活动暂未开放SOP下载" });
      return;
    }
    const fileName = `sop-${safeFileName(activity.id || activity.title)}.html`;
    await recordAuditLog(req, {
      action: "download",
      resourceType: "activity_sop",
      resourceId: activity.id,
      resourceTitle: activity.title,
      mediaType: "sop",
      filename: fileName,
      statusCode: 200
    }, user);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`
    });
    res.end(formatActivitySopHtml(activity));
    return;
  }

  // ---- 精彩案例(图片/视频展示,浏览免登录,下载需登录) ----
  if (req.method === "GET" && pathname === "/api/public/cases") {
    const db = readDb();
    const list = sortCases((db.cases || []).map(publicCase).filter(c => c.status === "published"));
    sendJson(res, 200, {
      cases: list,
      categories: caseCategories(list),
      count: list.length
    });
    return;
  }

  const publicCaseDetail = pathname.match(/^\/api\/public\/cases\/([^/]+)$/);
  if (req.method === "GET" && publicCaseDetail) {
    const db = readDb();
    const item = (db.cases || []).map(publicCase).find(c => c.id === publicCaseDetail[1] && c.status === "published");
    if (!item) return sendJson(res, 404, { error: "案例不存在或未发布" });
    return sendJson(res, 200, { case: item });
  }

  const caseDownload = pathname.match(/^\/api\/public\/cases\/([^/]+)\/download$/);
  if (req.method === "GET" && caseDownload) {
    const user = requireRole(req, res, VALID_ROLES);
    if (!user) return;
    const db = readDb();
    const item = (db.cases || []).map(publicCase).find(c => c.id === caseDownload[1] && c.status === "published");
    if (!item) return sendJson(res, 404, { error: "案例不存在或未发布" });
    const idx = Number(new URL(req.url, "http://localhost").searchParams.get("i") || 0);
    const media = Array.isArray(item.media) ? item.media : [];
    const m = media[idx];
    if (!m || !m.url) return sendJson(res, 404, { error: "素材不存在" });
    const filename = auditMediaFilename(m, idx);
    if (m.type === "link") {
      await recordAuditLog(req, {
        action: "download", resourceType: "case_media", resourceId: item.id,
        resourceTitle: item.title, mediaIndex: idx, mediaType: m.type,
        filename, statusCode: 200
      }, user);
      return sendJson(res, 200, { url: m.url });
    }
    const resolved = resolveLocalMediaPath(m.url);
    if (resolved.remote) {
      await recordAuditLog(req, {
        action: "download", resourceType: "case_media", resourceId: item.id,
        resourceTitle: item.title, mediaIndex: idx, mediaType: m.type,
        filename, statusCode: 200
      }, user);
      return sendJson(res, 200, { url: resolved.remote });
    }
    if (resolved.error) return sendJson(res, 400, { error: resolved.error });
    const filePath = resolved.path;
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "素材文件不存在" });
    const ext = path.extname(filePath).toLowerCase();
    await recordAuditLog(req, {
      action: "download", resourceType: "case_media", resourceId: item.id,
      resourceTitle: item.title, mediaIndex: idx, mediaType: m.type,
      filename, statusCode: 200
    }, user);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": fs.statSync(filePath).size,
      "Content-Disposition": `attachment; filename="case-${safeFileName(item.id)}-${idx}${ext}"`
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ---- 活动交付相册：公开 H5 浏览，上传和下载需要登录 ----
  const projectPath = pathname.match(/^\/api\/(my|admin)\/activity-projects(?:\/([^/]+))?$/);
  const projectId = projectPath && projectPath[2] ? decodeURIComponent(projectPath[2]) : "";

  if (req.method === "GET" && pathname === "/api/my/activity-projects") {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const db = readDb();
    const list = (db.activityProjects || [])
      .filter(p => user.role === "admin" || p.ownerId === user.id)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map(p => publicProject(p, db));
    return sendJson(res, 200, { projects: list, count: list.length });
  }

  if (req.method === "POST" && pathname === "/api/my/activity-projects") {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    db.activityProjects = db.activityProjects || [];
    const ts = now();
    const item = normalizeActivityProject({
      ...body,
      id: createId("project"),
      ownerId: user.id,
      ownerName: user.name || user.username,
      status: "published",
      createdAt: ts,
      updatedAt: ts
    });
    if (!item.title || item.title === "未命名活动相册") return sendJson(res, 400, { error: "请填写活动名称" });
    db.activityProjects.unshift(item);
    await writeDb(db);
    return sendJson(res, 201, { ok: true, project: publicProject(item, db) });
  }

  const publicProjectDetail = pathname.match(/^\/api\/public\/activity-projects\/([^/]+)$/);
  if (req.method === "GET" && publicProjectDetail) {
    const db = readDb();
    const item = (db.activityProjects || []).find(p => p.id === decodeURIComponent(publicProjectDetail[1]) && p.status === "published" && p.shareEnabled !== false);
    if (!item) return sendJson(res, 404, { error: "活动相册不存在或分享已关闭" });
    return sendJson(res, 200, { project: publicProject(item, db) });
  }

  const publicProjectDownload = pathname.match(/^\/api\/public\/activity-projects\/([^/]+)\/download$/);
  if (req.method === "GET" && publicProjectDownload) {
    const user = requireRole(req, res, VALID_ROLES);
    if (!user) return;
    const db = readDb();
    const item = (db.activityProjects || []).find(p => p.id === decodeURIComponent(publicProjectDownload[1]));
    if (!item || item.status !== "published" || item.shareEnabled === false) return sendJson(res, 404, { error: "活动相册不存在或分享已关闭" });
    const idx = Number(new URL(req.url, "http://localhost").searchParams.get("i") || 0);
    const media = Array.isArray(item.media) ? item.media : [];
    const m = media[idx];
    if (!m || !m.url) return sendJson(res, 404, { error: "素材不存在" });
    try {
      const url = projectDownloadUrl(item, m, idx);
      const filename = projectDownloadFileName(item, m, idx);
      await recordAuditLog(req, {
        action: "download", resourceType: "activity_project_media", resourceId: item.id,
        resourceTitle: item.title, mediaIndex: idx, mediaType: m.type,
        filename, statusCode: 200
      }, user);
      return sendJson(res, 200, { url, type: m.type, filename, disposition: "attachment" });
    } catch (error) {
      console.error("[project-download-sign]", error && (error.stack || error.message || error));
      return sendJson(res, 502, { error: "下载地址生成失败,请稍后重试" });
    }
  }

  const myProjectId = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)$/);
  if (myProjectId && (req.method === "GET" || req.method === "PATCH" || req.method === "DELETE")) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const db = readDb();
    const idx = (db.activityProjects || []).findIndex(p => p.id === decodeURIComponent(myProjectId[1]));
    if (idx < 0) return sendJson(res, 404, { error: "活动相册不存在" });
    const item = db.activityProjects[idx];
    if (!projectCanManage(user, item)) return sendJson(res, 403, { error: "当前账号不能管理这个活动相册" });
    if (req.method === "GET") {
      const project = publicProject(item, db);
      project.auditSummary = await loadProjectAuditSummary(item.id);
      return sendJson(res, 200, { project });
    }
    if (req.method === "DELETE") {
      db.activityProjects.splice(idx, 1);
      await writeDb(db);
      return sendJson(res, 200, { ok: true });
    }
    const body = await parseBody(req);
    const next = normalizeActivityProject({
      ...body,
      ownerId: item.ownerId,
      ownerName: item.ownerName,
      media: item.media,
      status: user.role === "admin" && body.status ? body.status : item.status,
      updatedAt: now()
    }, item);
    db.activityProjects[idx] = next;
    await writeDb(db);
    return sendJson(res, 200, { ok: true, project: publicProject(next, db) });
  }

  // 大视频采用 TOS Multipart：浏览器只拿短时效的单片 PUT 地址，避免维持一个几百 MB 的 API 长请求。
  const projectVideoUploadInit = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media\/init$/);
  if (req.method === "POST" && projectVideoUploadInit) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const db = readDb();
    const projectId = decodeURIComponent(projectVideoUploadInit[1]);
    const idx = (db.activityProjects || []).findIndex(p => p.id === projectId);
    if (idx < 0) return sendJson(res, 404, { error: "活动相册不存在" });
    const project = db.activityProjects[idx];
    if (!projectCanManage(user, project)) return sendJson(res, 403, { error: "当前账号不能上传到这个活动相册" });
    const body = await parseBody(req, 256 * 1024);
    const type = cleanString(body.type).toLowerCase();
    const ext = `.${cleanString(body.ext).toLowerCase().replace(/^\./, "")}`;
    const fileSize = Number(body.size);
    if (type !== "video" || !VIDEO_EXTS.includes(ext)) return sendJson(res, 400, { error: "分片上传仅支持 mp4、m4v、mov、webm 视频" });
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > 2 * 1024 * 1024 * 1024) {
      return sendJson(res, 413, { error: "视频不能超过2GB" });
    }

    const partSize = PROJECT_VIDEO_PART_SIZE;
    const partCount = Math.ceil(fileSize / partSize);
    const filename = `project_${project.id}_${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
    const object = projectVideoTosObject(filename);
    const { client, bucket } = getCaseVideoTosClient();
    let uploadId = "";
    try {
      const created = await client.createMultipartUpload({
        bucket,
        key: object.key,
        contentType: MIME_TYPES[ext] || "video/mp4",
        cacheControl: "public, max-age=31536000, immutable",
        contentDisposition: "inline"
      });
      uploadId = created?.data?.UploadId || created?.UploadId || "";
      if (!uploadId) throw new Error("TOS未返回Multipart UploadId");
      const sessionId = createId("project_upload");
      const ts = now();
      try {
        await pool.query(
          `INSERT INTO project_upload_sessions
           (id, project_id, owner_id, type, ext, title, filename, object_key, upload_id, file_size, part_size, part_count, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [sessionId, projectId, user.id, type, ext, cleanString(body.title).slice(0, 255), filename, object.key, uploadId, fileSize, partSize, partCount, "uploading", ts, ts]
        );
      } catch (error) {
        await client.abortMultipartUpload({ bucket, key: object.key, uploadId }).catch(() => {});
        throw error;
      }
      return sendJson(res, 201, {
        ok: true,
        sessionId,
        fileSize,
        partSize,
        partCount,
        expiresIn: 1800,
        storage: "tos-multipart"
      });
    } catch (error) {
      console.error("[project-video-multipart-init]", error && (error.stack || error.message || error));
      return sendJson(res, 502, { error: "视频分片上传初始化失败：" + (error.message || "未知错误") });
    }
  }

  const projectVideoPartUrl = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media\/upload-session\/([^/]+)\/part-url$/);
  if (req.method === "GET" && projectVideoPartUrl) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const projectId = decodeURIComponent(projectVideoPartUrl[1]);
    const session = await readProjectUploadSession(decodeURIComponent(projectVideoPartUrl[2]));
    if (!session || session.project_id !== projectId) return sendJson(res, 404, { error: "上传会话不存在" });
    const db = readDb();
    const project = (db.activityProjects || []).find(p => p.id === projectId);
    if (!project || !projectCanManage(user, project) || session.owner_id !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "当前账号不能使用这个上传会话" });
    }
    if (session.status !== "uploading") return sendJson(res, 409, { error: "上传会话已结束" });
    const partNumber = Number(new URL(req.url, "http://localhost").searchParams.get("partNumber"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Number(session.part_count)) {
      return sendJson(res, 400, { error: "无效的视频分片编号" });
    }
    try {
      const { client, bucket } = getCaseVideoTosClient();
      const url = client.getPreSignedUrl({
        bucket,
        key: session.object_key,
        method: "PUT",
        expires: 1800,
        query: { uploadId: session.upload_id, partNumber: String(partNumber) }
      });
      return sendJson(res, 200, { ok: true, url, partNumber, partSize: Number(session.part_size), expiresIn: 1800 });
    } catch (error) {
      console.error("[project-video-multipart-sign]", error && (error.stack || error.message || error));
      return sendJson(res, 502, { error: "视频分片地址生成失败" });
    }
  }

  const projectVideoUploadStatus = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media\/upload-session\/([^/]+)\/status$/);
  if (req.method === "GET" && projectVideoUploadStatus) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const projectId = decodeURIComponent(projectVideoUploadStatus[1]);
    const session = await readProjectUploadSession(decodeURIComponent(projectVideoUploadStatus[2]));
    if (!session || session.project_id !== projectId) return sendJson(res, 404, { error: "上传会话不存在" });
    const db = readDb();
    const project = (db.activityProjects || []).find(p => p.id === projectId);
    if (!project || !projectCanManage(user, project) || (session.owner_id !== user.id && user.role !== "admin")) {
      return sendJson(res, 403, { error: "当前账号不能查看这个上传会话" });
    }
    if (session.status === "completed") {
      return sendJson(res, 200, {
        ok: true,
        status: session.status,
        sessionId: session.id,
        filename: session.filename,
        fileSize: Number(session.file_size),
        partSize: Number(session.part_size),
        partCount: Number(session.part_count),
        completedParts: Array.from({ length: Number(session.part_count) }, (_, index) => index + 1),
        mediaUrl: session.media_url || ""
      });
    }
    if (session.status === "aborted") return sendJson(res, 409, { error: "上传会话已取消", status: session.status });
    try {
      const { client, bucket } = getCaseVideoTosClient();
      const listed = await client.listParts({ bucket, key: session.object_key, uploadId: session.upload_id, maxParts: 10000 });
      const parts = listed?.data?.Parts || listed?.Parts || [];
      const completedParts = parts.map(part => Number(part.PartNumber)).filter(Number.isInteger).sort((a, b) => a - b);
      const uploadedBytes = parts.reduce((total, part) => total + Math.max(0, Number(part.Size) || 0), 0);
      return sendJson(res, 200, {
        ok: true,
        status: session.status,
        sessionId: session.id,
        filename: session.filename,
        fileSize: Number(session.file_size),
        partSize: Number(session.part_size),
        partCount: Number(session.part_count),
        completedParts,
        uploadedBytes
      });
    } catch (error) {
      console.error("[project-video-multipart-status]", error && (error.stack || error.message || error));
      return sendJson(res, 502, { error: "视频上传进度读取失败，请稍后重试" });
    }
  }

  const projectVideoUploadComplete = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media\/upload-session\/([^/]+)\/complete$/);
  if (req.method === "POST" && projectVideoUploadComplete) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const projectId = decodeURIComponent(projectVideoUploadComplete[1]);
    const sessionId = decodeURIComponent(projectVideoUploadComplete[2]);
    const session = await readProjectUploadSession(sessionId);
    if (!session || session.project_id !== projectId) return sendJson(res, 404, { error: "上传会话不存在" });
    const db = readDb();
    const idx = (db.activityProjects || []).findIndex(p => p.id === projectId);
    if (idx < 0) return sendJson(res, 404, { error: "活动相册不存在" });
    const project = db.activityProjects[idx];
    if (!projectCanManage(user, project) || (session.owner_id !== user.id && user.role !== "admin")) {
      return sendJson(res, 403, { error: "当前账号不能完成这个上传会话" });
    }
    const existing = (project.media || []).find(m => m && m.url === session.media_url);
    if (session.status === "completed" && existing) {
      return sendJson(res, 200, { ok: true, media: existing, project: publicProject(project, db), storage: "tos-multipart", completed: true });
    }
    if (session.status === "aborted") return sendJson(res, 409, { error: "上传会话已取消" });

    const { client, bucket } = getCaseVideoTosClient();
    let objectCompleted = false;
    let databaseCommitted = false;
    try {
      let objectReady = false;
      let headResult = null;
      try {
        headResult = await client.headObject({ bucket, key: session.object_key });
      } catch {}
      if (headResult) {
        assertTosObjectSize(headResult, session.file_size);
        objectReady = true;
      }
      if (!objectReady) {
        const listed = await client.listParts({ bucket, key: session.object_key, uploadId: session.upload_id, maxParts: 10000 });
        const parts = listed?.data?.Parts || listed?.Parts || [];
        const expectedCount = Number(session.part_count);
        if (parts.length !== expectedCount) return sendJson(res, 409, { error: `视频仍有分片未上传（已收到${parts.length}/${expectedCount}片）` });
        const byNumber = new Map(parts.map(part => [Number(part.PartNumber), part]));
        for (let partNumber = 1; partNumber <= expectedCount; partNumber++) {
          const part = byNumber.get(partNumber);
          if (!part || !part.ETag) return sendJson(res, 409, { error: `视频第${partNumber}片未上传完成` });
          const expectedSize = partNumber < expectedCount
            ? Number(session.part_size)
            : Number(session.file_size) - (expectedCount - 1) * Number(session.part_size);
          if (Number(part.Size) !== expectedSize) return sendJson(res, 409, { error: `视频第${partNumber}片大小不完整` });
        }
        await client.completeMultipartUpload({ bucket, key: session.object_key, uploadId: session.upload_id, completeAll: true });
        headResult = await client.headObject({ bucket, key: session.object_key });
        assertTosObjectSize(headResult, session.file_size);
        objectCompleted = true;
      } else {
        objectCompleted = true;
      }

      const url = session.media_url || projectVideoTosObject(session.filename).url;
      const current = Array.isArray(project.media) ? project.media : [];
      const duplicate = current.find(item => item && item.url === url);
      const media = duplicate || {
        type: "video",
        url,
        title: cleanString(session.title),
        caption: "",
        size: Number(session.file_size),
        createdAt: now()
      };
      if (duplicate) databaseCommitted = true;
      if (!duplicate) {
        project.media = [...current, media];
        project.updatedAt = now();
        db.activityProjects[idx] = normalizeActivityProject(project, project);
        await writeDb(db);
        databaseCommitted = true;
      }
      await updateProjectUploadSession(sessionId, { status: "completed", media_url: url, error: null });
      return sendJson(res, duplicate ? 200 : 201, { ok: true, media, project: publicProject(db.activityProjects[idx], db), storage: "tos-multipart" });
    } catch (error) {
      if (objectCompleted && !databaseCommitted) {
        await client.deleteObject({ bucket, key: session.object_key }).catch(cleanupError => {
          console.error("[project-video-multipart-orphan-cleanup]", cleanupError && (cleanupError.stack || cleanupError.message || cleanupError));
        });
      }
      await updateProjectUploadSession(sessionId, { status: "failed", error: String(error.message || error).slice(0, 1000) }).catch(() => {});
      console.error("[project-video-multipart-complete]", error && (error.stack || error.message || error));
      return sendJson(res, 502, { error: "视频分片已上传，但 TOS 合并失败：" + (error.message || "未知错误") });
    }
  }

  const projectVideoUploadAbort = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media\/upload-session\/([^/]+)\/abort$/);
  if (req.method === "POST" && projectVideoUploadAbort) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const projectId = decodeURIComponent(projectVideoUploadAbort[1]);
    const sessionId = decodeURIComponent(projectVideoUploadAbort[2]);
    const session = await readProjectUploadSession(sessionId);
    if (!session || session.project_id !== projectId) return sendJson(res, 404, { error: "上传会话不存在" });
    const db = readDb();
    const project = (db.activityProjects || []).find(p => p.id === projectId);
    if (!project || !projectCanManage(user, project) || (session.owner_id !== user.id && user.role !== "admin")) {
      return sendJson(res, 403, { error: "当前账号不能取消这个上传会话" });
    }
    if (session.status === "uploading" || session.status === "failed") {
      const { client, bucket } = getCaseVideoTosClient();
      await client.abortMultipartUpload({ bucket, key: session.object_key, uploadId: session.upload_id }).catch(() => {});
      await updateProjectUploadSession(sessionId, { status: "aborted", error: "客户端取消上传" });
    }
    return sendJson(res, 200, { ok: true });
  }

  const myProjectMedia = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media$/);
  if (req.method === "POST" && myProjectMedia) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const db = readDb();
    const idx = (db.activityProjects || []).findIndex(p => p.id === decodeURIComponent(myProjectMedia[1]));
    if (idx < 0) return sendJson(res, 404, { error: "活动相册不存在" });
    const project = db.activityProjects[idx];
    if (!projectCanManage(user, project)) return sendJson(res, 403, { error: "当前账号不能上传到这个活动相册" });
    const u = new URL(req.url, "http://localhost");
    const type = cleanString(u.searchParams.get("type")).toLowerCase();
    const ext = `.${cleanString(u.searchParams.get("ext")).toLowerCase().replace(/^\./, "")}`;
    const validExts = type === "image" ? IMAGE_EXTS : type === "video" ? VIDEO_EXTS : [];
    if (!VALID_PROJECT_MEDIA_TYPES.includes(type)) return sendJson(res, 400, { error: "活动相册仅支持图片和视频" });
    if (!validExts.includes(ext)) return sendJson(res, 400, { error: "不支持的素材格式" });
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (type === "video" && declaredLength >= PROJECT_VIDEO_PART_SIZE) {
      req.resume();
      return sendJson(res, 409, {
        error: "大于等于16MB的视频必须使用分片上传，请刷新页面后重试",
        code: "PROJECT_VIDEO_MULTIPART_REQUIRED",
        threshold: PROJECT_VIDEO_PART_SIZE
      });
    }
    const maxSize = type === "video" ? 2 * 1024 * 1024 * 1024 : 50 * 1024 * 1024;
    const filename = `project_${project.id}_${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
    const dest = path.join(UPLOAD_DIR, `.project-${filename}`);
    const ws = fs.createWriteStream(dest);
    let size = 0;
    let aborted = false;
    req.on("aborted", () => { aborted = true; ws.destroy(); fs.unlink(dest, () => {}); });
    req.on("data", chunk => {
      size += chunk.length;
      if (type === "video" && size >= PROJECT_VIDEO_PART_SIZE && !aborted) {
        aborted = true;
        ws.destroy();
        fs.unlink(dest, () => {});
        sendJson(res, 409, {
          error: "大于等于16MB的视频必须使用分片上传，请刷新页面后重试",
          code: "PROJECT_VIDEO_MULTIPART_REQUIRED",
          threshold: PROJECT_VIDEO_PART_SIZE
        });
        req.destroy();
        return;
      }
      if (size > maxSize && !aborted) {
        aborted = true;
        ws.destroy();
        fs.unlink(dest, () => {});
        sendJson(res, 413, { error: `文件不能超过${type === "video" ? "2GB" : "50MB"}` });
        req.destroy();
      }
    });
    req.pipe(ws);
    ws.on("finish", async () => {
      if (aborted) return;
      if (size === 0) { fs.unlink(dest, () => {}); return sendJson(res, 400, { error: "未收到素材数据" }); }
      try {
        const fingerprint = await hashFileSHA256(dest);
        const current = Array.isArray(project.media) ? project.media : [];
        const duplicate = projectMediaDuplicate(current, fingerprint, size);
        if (duplicate) {
          fs.unlink(dest, () => {});
          return sendJson(res, 200, { ok: true, duplicate: true, media: duplicate, storage: "tos" });
        }
        const url = await uploadProjectFileToTos(dest, filename, type, MIME_TYPES[ext] || "application/octet-stream");
        const media = {
          type,
          url,
          title: cleanString(u.searchParams.get("title")),
          caption: cleanString(u.searchParams.get("caption")),
          size,
          fingerprint,
          createdAt: now()
        };
        project.media = [...current, media];
        if (!project.cover && type === "image") project.cover = url;
        project.updatedAt = now();
        db.activityProjects[idx] = normalizeActivityProject(project, project);
        await writeDb(db);
        fs.unlink(dest, () => {});
        return sendJson(res, 201, { ok: true, media, project: publicProject(db.activityProjects[idx], db), storage: "tos" });
      } catch (error) {
        fs.unlink(dest, () => {});
        console.error("[project-media-tos]", error && (error.stack || error.message || error));
        return sendJson(res, 502, { error: "素材已接收,但上传 TOS 失败：" + (error.message || "未知错误") });
      }
    });
    ws.on("error", error => {
      fs.unlink(dest, () => {});
      if (!aborted) sendJson(res, 500, { error: "素材写入失败" });
    });
    return;
  }

  const myProjectMediaDelete = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/media\/(\d+)$/);
  if (req.method === "DELETE" && myProjectMediaDelete) {
    const user = requireRole(req, res, ["admin", "operator", "member"]);
    if (!user) return;
    const db = readDb();
    const idx = (db.activityProjects || []).findIndex(p => p.id === decodeURIComponent(myProjectMediaDelete[1]));
    if (idx < 0) return sendJson(res, 404, { error: "活动相册不存在" });
    const project = db.activityProjects[idx];
    if (!projectCanManage(user, project)) return sendJson(res, 403, { error: "当前账号不能修改这个活动相册" });
    const mediaIndex = Number(myProjectMediaDelete[2]);
    if (!Number.isInteger(mediaIndex) || mediaIndex < 0 || mediaIndex >= (project.media || []).length) return sendJson(res, 404, { error: "素材不存在" });
    project.media.splice(mediaIndex, 1);
    if (project.cover && !project.media.some(m => m.url === project.cover)) project.cover = (project.media.find(m => m.type === "image") || {}).url || "";
    project.updatedAt = now();
    db.activityProjects[idx] = normalizeActivityProject(project, project);
    await writeDb(db);
    return sendJson(res, 200, { ok: true, project: publicProject(db.activityProjects[idx], db) });
  }

  const promoteProject = pathname.match(/^\/api\/my\/activity-projects\/([^/]+)\/promote-case$/);
  if (req.method === "POST" && promoteProject) {
    const user = requireRole(req, res, ["admin", "operator"]);
    if (!user) return;
    const db = readDb();
    const project = (db.activityProjects || []).find(p => p.id === decodeURIComponent(promoteProject[1]));
    if (!project) return sendJson(res, 404, { error: "活动相册不存在" });
    if (!projectCanManage(user, project)) return sendJson(res, 403, { error: "当前账号不能沉淀这个活动相册" });
    if (!project.media?.length) return sendJson(res, 400, { error: "请先上传照片或视频再沉淀案例" });
    if (project.sourceCaseId) return sendJson(res, 409, { error: "这个活动相册已经沉淀过案例" });
    const activity = (db.activities || []).find(a => a.id === project.activityId) || {};
    const ts = now();
    const item = normalizeCase({
      id: createId("case"),
      title: project.title,
      category: activity.category || "活动交付",
      city: project.city || activity.city || "",
      dateLabel: project.dateLabel,
      description: project.description,
      cover: project.cover,
      media: project.media,
      status: "draft",
      createdBy: user.id,
      createdAt: ts,
      updatedAt: ts,
      sourceProjectId: project.id
    });
    db.cases = db.cases || [];
    db.cases.unshift(item);
    project.sourceCaseId = item.id;
    project.updatedAt = ts;
    await writeDb(db);
    return sendJson(res, 201, { ok: true, case: item, project: publicProject(project, db), message: "已生成草稿案例，请在案例管理中审核发布" });
  }

  if (req.method === "GET" && pathname === "/api/admin/activity-projects") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    const list = (db.activityProjects || []).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).map(p => publicProject(p, db, { includeOwner: true }));
    return sendJson(res, 200, { projects: list, count: list.length });
  }

  if (req.method === "GET" && pathname === "/api/admin/cases") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    sendJson(res, 200, {
      cases: sortCases((db.cases || []).map(c => normalizeCase(c, c))),
      categories: caseCategories(db.cases || [])
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/cases") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    db.cases = db.cases || [];
    const ts = now();
    const item = normalizeCase({ ...body, id: createId("case"), createdBy: user.id, createdAt: ts, updatedAt: ts });
    if (!item.title) return sendJson(res, 400, { error: "案例标题不能为空" });
    db.cases.push(item);
    await writeDb(db);
    return sendJson(res, 201, { ok: true, case: item });
  }

  const adminCaseMoveMedia = pathname.match(/^\/api\/admin\/cases\/([^/]+)\/media\/(\d+)\/move$/);
  if (req.method === "POST" && adminCaseMoveMedia) {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const sourceId = adminCaseMoveMedia[1];
    const mediaIndex = Number(adminCaseMoveMedia[2]);
    const targetId = cleanString(body.targetCaseId || body.targetId || "");
    if (!targetId) return sendJson(res, 400, { error: "请选择目标案例" });
    if (targetId === sourceId) return sendJson(res, 400, { error: "目标案例不能是当前案例" });
    const db = readDb();
    db.cases = db.cases || [];
    const sourceIdx = db.cases.findIndex(c => c.id === sourceId);
    const targetIdx = db.cases.findIndex(c => c.id === targetId);
    if (sourceIdx === -1) return sendJson(res, 404, { error: "当前案例不存在" });
    if (targetIdx === -1) return sendJson(res, 404, { error: "目标案例不存在" });
    const sourceMedia = Array.isArray(db.cases[sourceIdx].media) ? db.cases[sourceIdx].media.slice() : [];
    if (!Number.isInteger(mediaIndex) || mediaIndex < 0 || mediaIndex >= sourceMedia.length) {
      return sendJson(res, 404, { error: "素材不存在" });
    }
    const moved = sourceMedia[mediaIndex];
    if (!moved || moved.type !== "video") {
      return sendJson(res, 400, { error: "目前仅支持转移视频素材" });
    }
    sourceMedia.splice(mediaIndex, 1);
    const targetMedia = Array.isArray(db.cases[targetIdx].media) ? db.cases[targetIdx].media.slice() : [];
    targetMedia.push(moved);
    const ts = now();
    const nextSource = {
      media: sourceMedia,
      updatedAt: ts
    };
    if (db.cases[sourceIdx].cover && db.cases[sourceIdx].cover === moved.url) {
      nextSource.cover = (sourceMedia.find(x => x.type === "image") || {}).url || "";
    }
    db.cases[sourceIdx] = normalizeCase(nextSource, db.cases[sourceIdx]);
    db.cases[targetIdx] = normalizeCase({ media: targetMedia, updatedAt: ts }, db.cases[targetIdx]);
    await writeDb(db);
    return sendJson(res, 200, { ok: true, case: db.cases[sourceIdx], targetCase: db.cases[targetIdx] });
  }

  const adminCaseId = pathname.match(/^\/api\/admin\/cases\/([^/]+)$/);
  if (req.method === "PATCH" && adminCaseId) {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    const idx = (db.cases || []).findIndex(c => c.id === adminCaseId[1]);
    if (idx === -1) return sendJson(res, 404, { error: "案例不存在" });
    db.cases[idx] = normalizeCase({ ...body, updatedAt: now() }, db.cases[idx]);
    if (!db.cases[idx].title) return sendJson(res, 400, { error: "案例标题不能为空" });
    await writeDb(db);
    return sendJson(res, 200, { ok: true, case: db.cases[idx] });
  }
  if (req.method === "DELETE" && adminCaseId) {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    const before = (db.cases || []).length;
    db.cases = (db.cases || []).filter(c => c.id !== adminCaseId[1]);
    if (db.cases.length === before) return sendJson(res, 404, { error: "案例不存在" });
    await writeDb(db);
    return sendJson(res, 200, { ok: true });
  }

  // 案例视频上传:先流式写临时盘,再上传 TOS; 前台播放不再经过业务服务器
  if (req.method === "POST" && pathname === "/api/admin/upload-video") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const u3 = new URL(req.url, "http://localhost");
    const ext = String(u3.searchParams.get("ext") || "mp4").toLowerCase();
    if (!["mp4", "mov", "m4v", "webm"].includes(ext)) {
      return sendJson(res, 400, { error: "仅支持 mp4 / mov / m4v / webm 视频" });
    }
    const filename = "video_" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + "." + ext;
    const dest = path.join(UPLOAD_DIR, filename);
    const ws = fs.createWriteStream(dest);
    let size = 0, aborted = false;
    req.on("data", chunk => { size += chunk.length; });
    req.pipe(ws);
    ws.on("finish", async () => {
      if (aborted) return;
      if (size === 0) { fs.unlink(dest, () => {}); return sendJson(res, 400, { error: "未收到视频数据" }); }
      try {
        const url = await uploadCaseVideoToTos(dest, filename, MIME_TYPES["." + ext] || "application/octet-stream");
        fs.unlink(dest, () => {});
        sendJson(res, 201, { ok: true, url, size, storage: "tos" });
      } catch (error) {
        console.error("[case-video-tos]", error && (error.stack || error.message || error));
        fs.unlink(dest, () => {});
        sendJson(res, 502, { error: "视频已接收,但上传 TOS 失败：" + (error.message || "未知错误") });
      }
    });
    ws.on("error", () => {
      fs.unlink(dest, () => {});
      if (!aborted) sendJson(res, 500, { error: "视频写入失败" });
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/upload-document") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const u3 = new URL(req.url, "http://localhost");
    const ext = String(u3.searchParams.get("ext") || "").toLowerCase().replace(/^\./, "");
    const safeExt = ext ? `.${ext}` : "";
    if (!DOCUMENT_EXTS.includes(safeExt)) {
      return sendJson(res, 400, { error: "仅支持 pdf / doc / docx / ppt / pptx / xls / xlsx / csv / txt 文档" });
    }
    const MAX_DOCUMENT = 80 * 1024 * 1024;
    const filename = "document_" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + safeExt;
    const dest = path.join(UPLOAD_DIR, filename);
    const ws = fs.createWriteStream(dest);
    let size = 0, aborted = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_DOCUMENT && !aborted) {
        aborted = true;
        ws.destroy();
        fs.unlink(dest, () => {});
        sendJson(res, 413, { error: "文档不能超过80MB" });
        req.destroy();
      }
    });
    req.pipe(ws);
    ws.on("finish", async () => {
      if (aborted) return;
      if (size === 0) { fs.unlink(dest, () => {}); return sendJson(res, 400, { error: "未收到文档数据" }); }
      try {
        const url = await uploadCaseDocumentToTos(dest, filename, MIME_TYPES[safeExt] || "application/octet-stream");
        fs.unlink(dest, () => {});
        sendJson(res, 201, { ok: true, url, size, storage: "tos" });
      } catch (error) {
        fs.unlink(dest, () => {});
        sendJson(res, 502, { error: "文档已接收,但上传 TOS 失败：" + (error.message || "未知错误") });
      }
    });
    ws.on("error", () => {
      fs.unlink(dest, () => {});
      if (!aborted) sendJson(res, 500, { error: "文档写入失败" });
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/activities") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    sendJson(res, 200, {
      activities: db.activities.sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    });
    return;
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/admin/activities/")) {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const id = pathname.split("/").pop();
    const body = await parseBody(req);
    const db = readDb();
    const idx = db.activities.findIndex(a => a.id === id);
    if (idx === -1) return sendJson(res, 404, { error: "活动不存在" });
    db.activities[idx] = { ...db.activities[idx], ...body, updatedAt: new Date().toISOString() };
    await writeDb(db);
    return sendJson(res, 200, { ok: true, activity: db.activities[idx] });
  }

  if (req.method === "POST" && pathname === "/api/my-upload-image") {
    let user = null;
    try { user = getAuthedUser(req); } catch (e) {}
    if (!user) { sendJson(res, 401, { error: "请先登录" }); return; }
    await handleImageUpload(req, res, "image");
    return;
  }

  if (req.method === "POST" && pathname === "/api/my-activities") {
    let user = null;
    try { user = getAuthedUser(req); } catch (e) {}
    if (!user) {
      sendJson(res, 401, { error: "请先登录后再提交" });
      return;
    }
    const body = await parseBody(req);
    const db = readDb();
    const activity = normalizeActivity(body);
    if (!activity.title) {
      sendJson(res, 400, { error: "请填写活动标题" });
      return;
    }
    // 强制收紧：用户提交一律待审核，记录提交人，禁止自定义敏感字段
    activity.id = createId("act");
    activity.createdAt = now();
    activity.status = "pending";
    activity.ownerId = user.id;
    activity.submittedBy = user.id;
    activity.submittedByName = user.name || user.username;
    activity.sortOrder = 9999;
    activity.importSource = "前台共创提交";
    if (!activity.cover && activity.images[0]) activity.cover = activity.images[0];
    db.activities.unshift(activity);
    await writeDb(db);
    sendJson(res, 201, { ok: true, message: "已提交，等待总部审核通过后上线" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/activities") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    const activity = normalizeActivity(body);
    if (!activity.title) {
      sendJson(res, 400, { error: "请填写活动标题" });
      return;
    }
    activity.id = createId("act");
    activity.createdAt = now();
    activity.ownerId = user.id;
    if (!activity.cover && activity.images[0]) activity.cover = activity.images[0];
    db.activities.unshift(activity);
    await writeDb(db);
    sendJson(res, 201, { activity });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/import-activities") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req, 32 * 1024 * 1024);
    const items = Array.isArray(body.activities) ? body.activities : (Array.isArray(body.items) ? body.items : []);
    if (!items.length) {
      sendJson(res, 400, { error: "请导入活动数组，格式为 { activities: [...] } 或直接在前端粘贴数组" });
      return;
    }
    const db = readDb();
    const result = { created: 0, updated: 0, skipped: 0 };
    const changed = [];
    items.forEach(raw => {
      if (!raw || typeof raw !== "object") {
        result.skipped += 1;
        return;
      }
      const title = String(raw.title || "").trim();
      if (!title) {
        result.skipped += 1;
        return;
      }
      const existingIndex = db.activities.findIndex(activity =>
        (raw.id && activity.id === raw.id) ||
        (raw.number && activity.number === raw.number && activity.title === title)
      );
      const existing = existingIndex >= 0 ? db.activities[existingIndex] : {};
      const activity = normalizeActivity({
        ...raw,
        status: raw.status || "pending",
        region: raw.region || raw.area || raw.city,
        activityType: raw.activityType || raw.type || raw.subCategory
      }, existing);
      activity.id = existing.id || raw.id || createId("act");
      activity.createdAt = existing.createdAt || now();
      activity.ownerId = existing.ownerId || user.id;
      activity.importSource = raw.importSource || body.importSource || "小程序/外部表单导入";
      if (!activity.cover && activity.images[0]) activity.cover = activity.images[0];
      if (existingIndex >= 0) {
        db.activities[existingIndex] = activity;
        result.updated += 1;
      } else {
        db.activities.unshift(activity);
        result.created += 1;
      }
      changed.push(activity);
    });
    await writeDb(db);
    sendJson(res, 200, { ...result, activities: changed });
    return;
  }

  const adminActivity = pathname.match(/^\/api\/admin\/activities\/([^/]+)$/);
  if (adminActivity && req.method === "PUT") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    const index = db.activities.findIndex(x => x.id === adminActivity[1]);
    if (index < 0) {
      sendJson(res, 404, { error: "活动不存在" });
      return;
    }
    const updated = normalizeActivity(body, db.activities[index]);
    if (!updated.cover && updated.images[0]) updated.cover = updated.images[0];
    db.activities[index] = updated;
    await writeDb(db);
    sendJson(res, 200, { activity: updated });
    return;
  }

  if (adminActivity && req.method === "DELETE") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    const next = db.activities.filter(x => x.id !== adminActivity[1]);
    if (next.length === db.activities.length) {
      sendJson(res, 404, { error: "活动不存在" });
      return;
    }
    db.activities = next;
    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/upload-image") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    await handleImageUpload(req, res, "image");
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const db = readDb();
    sendJson(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/users") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    if (!username || !password) {
      sendJson(res, 400, { error: "请填写账号和初始密码" });
      return;
    }
    const db = readDb();
    if (db.users.some(x => x.username === username)) {
      sendJson(res, 409, { error: "账号已存在" });
      return;
    }
    const salt = crypto.randomBytes(8).toString("hex");
    const newUser = {
      id: createId("u"),
      username,
      name: String(body.name || username).trim(),
      role: VALID_ROLES.includes(body.role) ? body.role : "member",
      status: body.status === "disabled" ? "disabled" : "active",
      canDownload: Boolean(body.canDownload),
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: now()
    };
    db.users.push(newUser);
    await writeDb(db);
    sendJson(res, 201, { user: publicUser(newUser) });
    return;
  }

  const adminUser = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUser && req.method === "PUT") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req);
    const db = readDb();
    const target = db.users.find(x => x.id === adminUser[1]);
    if (!target) {
      sendJson(res, 404, { error: "账号不存在" });
      return;
    }
    target.name = String(body.name || target.name).trim();
    target.role = VALID_ROLES.includes(body.role) ? body.role : target.role;
    target.status = body.status === "disabled" ? "disabled" : "active";
    target.canDownload = ["admin", "operator"].includes(target.role) ? true : Boolean(body.canDownload);
    if (body.password) {
      target.salt = crypto.randomBytes(8).toString("hex");
      target.passwordHash = hashPassword(String(body.password), target.salt);
    }
    await writeDb(db);
    sendJson(res, 200, { user: publicUser(target) });
    return;
  }

  if (adminUser && req.method === "DELETE") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    if (user.id === adminUser[1]) {
      sendJson(res, 400, { error: "不能删除当前登录账号" });
      return;
    }
    const db = readDb();
    db.users = db.users.filter(x => x.id !== adminUser[1]);
    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  // 智能解析：粘贴活动文案 → DeepSeek 抽取成结构化活动
  if (req.method === "POST" && pathname === "/api/admin/parse-activity") {
    const user = requireRole(req, res, ["admin"]);
    if (!user) return;
    const body = await parseBody(req, 512 * 1024);
    const text = String(body.text || "").trim();
    if (!text) { sendJson(res, 400, { error: "请粘贴活动文案/流程" }); return; }
    if (text.length > 8000) { sendJson(res, 400, { error: "文案过长，请控制在8000字以内" }); return; }
    try {
      const activity = await parseActivityWithAI(text);
      sendJson(res, 200, { activity });
    } catch (e) {
      sendJson(res, 502, { error: "智能解析失败：" + (e.message || "调用AI出错") });
    }
    return;
  }

  sendJson(res, 404, { error: "API不存在" });
}

function handleStatic(req, res, pathname) {
  if (pathname === "/admin" || pathname === "/admin/") {
    serveFile(res, path.join(PUBLIC_DIR, "admin.html"));
    return;
  }
  if (pathname === "/" || pathname.startsWith("/activity/")) {
    serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }
  if (pathname.startsWith("/uploads/")) {
    const filePath = safeStaticPath(ROOT, pathname);
    if (!filePath || !filePath.startsWith(UPLOAD_DIR)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    serveFile(res, filePath, req);
    return;
  }
  const filePath = safeStaticPath(PUBLIC_DIR, pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }
  serveFile(res, filePath);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    handleStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器错误" });
  }
});

initDb()
  .then(async () => {
    await cleanupStaleProjectUploadSessions().catch(error => {
      console.error("[project-upload-cleanup]", error && (error.stack || error.message || error));
    });
    const cleanupTimer = setInterval(() => {
      cleanupStaleProjectUploadSessions().catch(error => {
        console.error("[project-upload-cleanup]", error && (error.stack || error.message || error));
      });
    }, 6 * 60 * 60 * 1000);
    cleanupTimer.unref();
    server.listen(PORT, () => {
      console.log(`Silver community H5 (MySQL) running at http://localhost:${PORT}`);
      console.log(`Admin console: http://localhost:${PORT}/admin`);
    });
  })
  .catch(err => {
    console.error("数据库初始化失败，服务未启动：", err.message);
    process.exit(1);
  });
