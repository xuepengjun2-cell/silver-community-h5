const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SESSION_FILE = path.join(DATA_DIR, "sessions.json");
const SEED_ACTIVITIES_FILE = path.join(DATA_DIR, "seed-activities.json");
const SITE_CONFIG_FILE = path.join(DATA_DIR, "site-config.json");
const VALID_ROLES = ["admin", "operator", "viewer", "member"];
const VALID_ACTIVITY_STATUSES = ["published", "pending", "draft", "rejected"];

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
  ".ico": "image/x-icon"
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function seedActivities() {
  return readJson(SEED_ACTIVITIES_FILE, []);
}

function seedDb() {
  const adminSalt = "demo-admin";
  const operatorSalt = "demo-operator";
  const memberSalt = "demo-member";
  return {
    users: [
      {
        id: "u_admin",
        username: "admin",
        name: "总部管理员",
        role: "admin",
        status: "active",
        canDownload: true,
        salt: adminSalt,
        passwordHash: hashPassword("admin123", adminSalt),
        createdAt: now()
      },
      {
        id: "u_operator",
        username: "city",
        name: "城市主理人",
        role: "operator",
        status: "active",
        canDownload: true,
        salt: operatorSalt,
        passwordHash: hashPassword("city123", operatorSalt),
        createdAt: now()
      },
      {
        id: "u_member",
        username: "member",
        name: "普通学习用户",
        role: "member",
        status: "active",
        canDownload: true,
        salt: memberSalt,
        passwordHash: hashPassword("member123", memberSalt),
        createdAt: now()
      }
    ],
    activities: seedActivities().length ? seedActivities() : [
      {
        id: "act_social_001",
        status: "published",
        title: "遇见同频的TA｜同城精致社交下午茶",
        city: "北京",
        category: "同城社交",
        price: "398元/人",
        capacity: "16-32人",
        duration: "3.5小时",
        location: "高雅西餐厅或会所茶室",
        cover: "/assets/people/cn-social-cafe.jpg",
        images: ["/assets/people/cn-social-cafe.jpg", "/assets/people/cn-card-social.jpg"],
        tags: ["单身社交", "下午茶", "高品质"],
        intro: "面向退休后希望拓展同频关系的银发用户，通过精致下午茶、话题卡和社交肖像，建立体面、轻松、有边界感的互动场景。",
        highlights: ["男女限额，报名审核", "三不问社交脚本，保护用户尊严", "输出个人社交肖像与后续牵线服务"],
        schedule: [
          { time: "14:00", item: "签到、胸牌与社交破冰" },
          { time: "14:30", item: "下午茶与走心话题卡交流" },
          { time: "16:00", item: "互选卡填写与主理人私下撮合" },
          { time: "17:00", item: "社交肖像拍摄与合影" }
        ],
        plan: {
          target: "筛选高品质社交用户，沉淀单身兴趣标签，承接会员与私域牵线服务。",
          materials: "红蓝大字号胸牌、话题卡、盲选互选卡、无糖下午茶、拍摄补光设备。",
          staffing: "1名主理人、1名签到助理、1名现场摄影、1名秩序维护。",
          conversion: "活动后24小时内私聊反馈，邀请进入同城社交会员群，并推荐下一场主题茶聚。",
          risk: "严格审核报名信息，不公开收入、房产、子女等敏感问题。"
        },
        contact: "评论区留言或扫码咨询主理人",
        updatedAt: now(),
        createdAt: now()
      },
      {
        id: "act_ktv_002",
        status: "published",
        title: "80年代怀旧KTV欢唱局",
        city: "北京",
        category: "声乐欢聚",
        price: "69元/人",
        capacity: "20-40人",
        duration: "3小时",
        location: "同城高端纯K包厢",
        cover: "/assets/people/cn-singing-salon.jpg",
        images: ["/assets/people/cn-singing-salon.jpg", "/assets/people/cn-rhythm-class.jpg"],
        tags: ["KTV", "怀旧金曲", "短视频输出"],
        intro: "用经典金曲把同龄人聚到一起，不拼唱功，只强调开心、陪伴和可展示的高光片段。",
        highlights: ["大字金曲歌单", "个人副歌高光短视频", "可衔接声乐课和合唱团"],
        schedule: [
          { time: "13:30", item: "签到、点歌与分组" },
          { time: "14:00", item: "怀旧金曲接龙" },
          { time: "15:30", item: "个人副歌高光录制" },
          { time: "16:20", item: "合唱收尾与群内作品发布" }
        ],
        plan: {
          target: "获取声乐兴趣用户，筛选愿意上台和参与合唱的高活跃人群。",
          materials: "立式麦克风、彩色闪光棒、大字金曲歌单、手机稳定器。",
          staffing: "1名主理人、1名控场主持、1名拍摄剪辑人员。",
          conversion: "活动后发布个人唱段，邀请报名7天唱好一首歌陪练营。",
          risk: "控制音量和时长，避免过度劝酒，确保场地动线安全。"
        },
        contact: "评论区留言1，主理人邀请进群",
        updatedAt: now(),
        createdAt: now()
      },
      {
        id: "act_drum_003",
        status: "published",
        title: "零基础非洲鼓欢聚体验",
        city: "上海",
        category: "兴趣课程",
        price: "99元/人",
        capacity: "20-50人",
        duration: "2.5小时",
        location: "舞蹈房或宽敞活动厅",
        cover: "/assets/people/cn-rhythm-class.jpg",
        images: ["/assets/people/cn-rhythm-class.jpg", "/assets/people/cn-singing-salon.jpg"],
        tags: ["非洲鼓", "零基础", "团队氛围"],
        intro: "节奏简单、氛围热烈，适合没有音乐基础但希望参与集体互动的银发用户。",
        highlights: ["人手一面鼓", "大字号节奏图谱", "输出团队合影和个人Solo短视频"],
        schedule: [
          { time: "09:30", item: "签到与节奏热身" },
          { time: "10:00", item: "基础节拍教学" },
          { time: "11:00", item: "分组合作演奏" },
          { time: "11:40", item: "个人Solo与集体合影" }
        ],
        plan: {
          target: "打造强氛围获客活动，承接非洲鼓班、舞蹈班和会员报名。",
          materials: "标准非洲鼓、彩色头带、节奏图谱、音响、小蜜蜂。",
          staffing: "1名专业老师、1名主理人、1名助教、1名拍摄人员。",
          conversion: "体验后推出4周非洲鼓入门班，附赠一次会员聚会权益。",
          risk: "控制敲击强度，准备饮水和休息区。"
        },
        contact: "点击报名或联系城市主理人",
        updatedAt: now(),
        createdAt: now()
      },
      {
        id: "act_flower_004",
        status: "published",
        title: "插花艺术与空间美学沙龙",
        city: "杭州",
        category: "品位生活",
        price: "198元/人",
        capacity: "15-28人",
        duration: "2.5小时",
        location: "鲜花美学工作室",
        cover: "/assets/people/cn-flower-salon.jpg",
        images: ["/assets/people/cn-flower-salon.jpg", "/assets/people/cn-social-cafe.jpg"],
        tags: ["插花", "美学", "作品带走"],
        intro: "通过花材搭配、空间摆放和作品展示，满足银发用户的审美表达和社交分享需求。",
        highlights: ["专业花艺老师指导", "作品可带回家", "适合会员权益活动"],
        schedule: [
          { time: "14:00", item: "签到、花材领取" },
          { time: "14:20", item: "花艺审美与色彩搭配" },
          { time: "15:10", item: "个人插花创作" },
          { time: "16:00", item: "作品展示与合影" }
        ],
        plan: {
          target: "吸引高审美、高复购的女性用户，转化会员与美学系列课程。",
          materials: "时令鲜花、瓷花器、圆头剪刀、包装袋、拍摄背景布。",
          staffing: "1名花艺老师、1名主理人、1名助教、1名摄影。",
          conversion: "活动后邀请进入美学会员群，推荐旗袍、茶会、形象课程。",
          risk: "剪刀统一管理，花粉敏感用户提前提醒。"
        },
        contact: "评论区留言，获取本周名额",
        updatedAt: now(),
        createdAt: now()
      },
      {
        id: "act_card_005",
        status: "published",
        title: "同城银发掼蛋友谊赛",
        city: "南京",
        category: "棋牌社交",
        price: "88元/人",
        capacity: "16-48人",
        duration: "3小时",
        location: "高级棋牌会所或俱乐部活动厅",
        cover: "/assets/people/cn-card-social.jpg",
        images: ["/assets/people/cn-card-social.jpg", "/assets/people/cn-social-cafe.jpg"],
        tags: ["掼蛋", "友谊赛", "老带新"],
        intro: "以轻松比赛的形式组织同城同龄人相识，适合高频复购和老带新裂变。",
        highlights: ["大字号积分榜", "荣誉奖状", "适合固定月赛机制"],
        schedule: [
          { time: "13:30", item: "签到抽签与规则说明" },
          { time: "14:00", item: "第一轮友谊赛" },
          { time: "15:20", item: "茶歇与换桌交流" },
          { time: "16:10", item: "颁发荣誉奖状" }
        ],
        plan: {
          target: "建立高频同城社交场，沉淀稳定棋牌会员。",
          materials: "加厚扑克、大字号积分榜、奖状、茶水点心。",
          staffing: "1名主理人、1名裁判兼计分、1名签到助理。",
          conversion: "赛后发起月度掼蛋会员卡，鼓励带朋友组队。",
          risk: "明确娱乐属性，禁止现金输赢。"
        },
        contact: "评论区扣1，主理人发报名链接",
        updatedAt: now(),
        createdAt: now()
      }
    ]
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    writeJson(DB_FILE, seedDb());
  }
  return readJson(DB_FILE, {});
}

function writeDb(db) {
  writeJson(DB_FILE, db);
}

function readSiteConfig(){return readJson(SITE_CONFIG_FILE,{heroTitle:"",heroDesc:"",featuredIds:[]});}
function writeSiteConfig(c){writeJson(SITE_CONFIG_FILE,c);}
function readSessions() {
  return global._sessions || (global._sessions = {});
}

function writeSessions(sessions) {
  global._sessions = sessions;
}

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
    canDownload: ["admin", "operator"].includes(user.role) ? true : Boolean(user.canDownload)
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
    "三、活动流程",
    schedule,
    "",
    "四、运营目标",
    plan.target || "待补充",
    "",
    "五、核心物料",
    plan.materials || "待补充",
    "",
    "六、人力配置",
    plan.staffing || "待补充",
    "",
    "七、转化承接",
    plan.conversion || "待补充",
    "",
    "八、风险控制",
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

function safeFileName(value) {
  return String(value || "activity")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "activity";
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
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
  if (req.method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(getAuthedUser(req)) });
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
    writeSessions(sessions);
    sendJson(res, 200, { user: publicUser(user) }, {
      "Set-Cookie": `silver_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = getCookieToken(req);
    const sessions = readSessions();
    if (token) delete sessions[token];
    writeSessions(sessions);
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": "silver_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    });
    return;
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
      activities,
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
    sendJson(res, 200, { activity });
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
    const canDownload = ["admin", "operator"].includes(user.role) || Boolean(user.canDownload);
    if (activity.downloadEnabled === false || !canDownload) {
      sendJson(res, 403, { error: "当前账号暂未开通SOP下载权限，请联系管理员" });
      return;
    }
    const fileName = `sop-${safeFileName(activity.id || activity.title)}.txt`;
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`
    });
    res.end(formatActivitySop(activity));
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/activities") {
    const user = requireRole(req, res, ["admin", "operator", "viewer"]);
    if (!user) return;
    const db = readDb();
    sendJson(res, 200, {
      activities: db.activities.sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/activities") {
    const user = requireRole(req, res, ["admin", "operator"]);
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
    writeDb(db);
    sendJson(res, 201, { activity });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/import-activities") {
    const user = requireRole(req, res, ["admin", "operator"]);
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
    writeDb(db);
    sendJson(res, 200, { ...result, activities: changed });
    return;
  }

  const adminActivity = pathname.match(/^\/api\/admin\/activities\/([^/]+)$/);
  if (adminActivity && req.method === "PUT") {
    const user = requireRole(req, res, ["admin", "operator"]);
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
    writeDb(db);
    sendJson(res, 200, { activity: updated });
    return;
  }

  if (adminActivity && req.method === "DELETE") {
    const user = requireRole(req, res, ["admin", "operator"]);
    if (!user) return;
    const db = readDb();
    const next = db.activities.filter(x => x.id !== adminActivity[1]);
    if (next.length === db.activities.length) {
      sendJson(res, 404, { error: "活动不存在" });
      return;
    }
    db.activities = next;
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/upload-image") {
    const user = requireRole(req, res, ["admin", "operator"]);
    if (!user) return;
    const body = await parseBody(req, 24 * 1024 * 1024);
    const dataUrl = String(body.dataUrl || "");
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
    if (!match) {
      sendJson(res, 400, { error: "请上传 png、jpg、webp 或 gif 图片" });
      return;
    }
    const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 8 * 1024 * 1024) {
      sendJson(res, 400, { error: "单张图片不能超过8MB" });
      return;
    }
    const filename = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${extMap[match[1]]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    sendJson(res, 201, { url: `/uploads/${filename}` });
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
    writeDb(db);
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
    writeDb(db);
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
    writeDb(db);
    sendJson(res, 200, { ok: true });
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
    if(req.method==="GET"&&pathname==="/api/site-config"){return sendJson(res,200,{config:readSiteConfig()});}
    if(req.method==="POST"&&pathname==="/api/admin/site-config"){const u=requireRole(req,res,["admin"]);if(!u)return;const b=await readBody(req);const c=readSiteConfig();if(b.heroTitle!==undefined)c.heroTitle=b.heroTitle;if(b.heroDesc!==undefined)c.heroDesc=b.heroDesc;if(b.featuredIds!==undefined)c.featuredIds=b.featuredIds;writeSiteConfig(c);return sendJson(res,200,{ok:true,config:c});}
    const filePath = safeStaticPath(ROOT, pathname);
    if (!filePath || !filePath.startsWith(UPLOAD_DIR)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    serveFile(res, filePath);
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

server.listen(PORT, () => {
  console.log(`Silver community H5 running at http://localhost:${PORT}`);
  console.log(`Admin console: http://localhost:${PORT}/admin`);
});
