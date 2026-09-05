const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const ROOT = process.env.SILVER_ROOT || __dirname;
const UPLOAD_DIR = process.env.SILVER_UPLOAD_DIR || path.join(ROOT, "uploads");
const IMAGE_TOS_PREFIX = String(process.env.CASE_IMAGE_TOS_PREFIX || "silver-images").replace(/^\/+|\/+$/g, "");
const IMAGE_PUBLIC_BASE = String(process.env.CASE_IMAGE_PUBLIC_BASE || `https://proj2.likeduoduiyi.cn/${IMAGE_TOS_PREFIX}`).replace(/\/+$/g, "");
const DEFAULT_TOS_ENV_FILES = ["/etc/itinerary-admin.env", "/opt/learning-upload/tos.env"];
const DEFAULT_TOS_SDK_PATH = "/opt/course-tob/node_modules/@volcengine/tos-sdk";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8"
};

const commit = process.argv.includes("--commit");

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

function parseDoc(v) {
  if (v == null) return v;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function getDbConfig() {
  const env = { ...parseEnvFile("/etc/silver-community.env"), ...process.env };
  return {
    host: env.DB_HOST || "127.0.0.1",
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || "silver",
    password: env.DB_PASS || "",
    database: env.DB_NAME || "silver",
    charset: "utf8mb4"
  };
}

function getTosClient() {
  const fileEnv = DEFAULT_TOS_ENV_FILES.reduce((acc, file) => ({ ...acc, ...parseEnvFile(file) }), {});
  const env = { ...fileEnv, ...process.env };
  const required = ["TOS_ACCESS_KEY_ID", "TOS_SECRET_ACCESS_KEY", "TOS_BUCKET", "TOS_ENDPOINT"];
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error(`TOS配置缺失: ${missing.join(",")}`);
  const { TosClient } = require(process.env.TOS_SDK_PATH || DEFAULT_TOS_SDK_PATH);
  return {
    client: new TosClient({
      accessKeyId: env.TOS_ACCESS_KEY_ID,
      accessKeySecret: env.TOS_SECRET_ACCESS_KEY,
      region: env.TOS_REGION || "cn-beijing",
      endpoint: env.TOS_ENDPOINT
    }),
    bucket: env.TOS_BUCKET
  };
}

function normalizeUploadUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith(IMAGE_PUBLIC_BASE + "/")) return "";
  if (raw.startsWith("/uploads/")) return raw.slice("/uploads/".length);
  if (raw.startsWith("/silver-api/uploads/")) return raw.slice("/silver-api/uploads/".length);
  try {
    const u = new URL(raw);
    if (u.pathname.startsWith("/silver-api/uploads/")) return u.pathname.slice("/silver-api/uploads/".length);
    if (u.pathname.startsWith("/uploads/")) return u.pathname.slice("/uploads/".length);
  } catch {
    return "";
  }
  return "";
}

function safeUploadPath(rel) {
  const decoded = decodeURIComponent(rel);
  const full = path.normalize(path.join(UPLOAD_DIR, decoded));
  const root = path.normalize(UPLOAD_DIR + path.sep);
  if (!full.startsWith(root)) return "";
  return full;
}

function publicUrlForKey(key) {
  const suffix = key.slice(IMAGE_TOS_PREFIX.length + 1).split("/").map(encodeURIComponent).join("/");
  return `${IMAGE_PUBLIC_BASE}/${suffix}`;
}

async function main() {
  const conn = await mysql.createConnection(getDbConfig());
  const { client, bucket } = getTosClient();
  const uploaded = new Map();
  const stats = { scanned: 0, changed: 0, uploaded: 0, missing: 0, skipped: 0 };

  async function migrateUrl(value) {
    const rel = normalizeUploadUrl(value);
    if (!rel) return value;
    stats.scanned++;
    const ext = path.extname(rel.split("?")[0].split("#")[0]).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      stats.skipped++;
      return value;
    }
    const filePath = safeUploadPath(rel);
    if (!filePath || !fs.existsSync(filePath)) {
      stats.missing++;
      console.warn(`[missing] ${value}`);
      return value;
    }
    if (uploaded.has(rel)) return uploaded.get(rel);
    const key = `${IMAGE_TOS_PREFIX}/legacy/${rel.replace(/\\/g, "/").split("/").map(part => part.replace(/[^\w.-]/g, "_")).join("/")}`;
    const nextUrl = publicUrlForKey(key);
    if (commit) {
      const stat = fs.statSync(filePath);
      await client.putObjectFromFile({
        bucket,
        key,
        filePath,
        contentLength: stat.size,
        contentType: MIME_TYPES[ext] || "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
        contentDisposition: "inline"
      });
      stats.uploaded++;
    }
    uploaded.set(rel, nextUrl);
    return nextUrl;
  }

  async function walk(value) {
    if (typeof value === "string") return migrateUrl(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = [];
      for (const item of value) {
        const mapped = await walk(item);
        if (mapped !== item) changed = true;
        next.push(mapped);
      }
      return changed ? next : value;
    }
    if (!value || typeof value !== "object") return value;
    let changed = false;
    const next = { ...value };
    for (const key of Object.keys(next)) {
      const mapped = await walk(next[key]);
      if (mapped !== next[key]) changed = true;
      next[key] = mapped;
    }
    return changed ? next : value;
  }

  async function migrateDocTable(table) {
    const [rows] = await conn.query(`SELECT id, doc FROM ${table}`);
    for (const row of rows) {
      const doc = parseDoc(row.doc);
      const next = await walk(doc);
      if (next !== doc) {
        stats.changed++;
        console.log(`[${commit ? "update" : "dry"}] ${table}/${row.id}`);
        if (commit) await conn.query(`UPDATE ${table} SET doc=? WHERE id=?`, [JSON.stringify(next), row.id]);
      }
    }
  }

  await migrateDocTable("activities");
  await migrateDocTable("posts");
  await migrateDocTable("cases");

  const [settings] = await conn.query("SELECT k, v FROM site_config");
  for (const row of settings) {
    const value = parseDoc(row.v);
    const next = await walk(value);
    if (next !== value) {
      stats.changed++;
      console.log(`[${commit ? "update" : "dry"}] site_config/${row.k}`);
      if (commit) await conn.query("UPDATE site_config SET v=? WHERE k=?", [JSON.stringify(next), row.k]);
    }
  }

  await conn.end();
  console.log(JSON.stringify({ mode: commit ? "commit" : "dry-run", ...stats }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err);
  process.exit(1);
});
