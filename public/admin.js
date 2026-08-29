// =============================================
//  开开华彩 · 活动管理后台
// =============================================

const adminApp = document.querySelector("#adminApp");
const SILVER_PUBLIC_MODE = location.hostname === "proj2.likeduoduiyi.cn";
const SILVER_FRONT_BASE = SILVER_PUBLIC_MODE ? "https://proj2.likeduoduiyi.cn/silver" : "";
const SILVER_API_BASE = SILVER_PUBLIC_MODE ? "https://apip2.kkhuacai08.cn/silver-api" : "";
const AUTH_TOKEN_KEY = "silver_auth_token";

const state = {
  user: null,
  activities: [],
  activityProjects: [],
  users: [],
  auditSummary: [],
  activeTab: "activities",
  editingId: null,
  imageUrls: [],
  scheduleRows: [],
  tags: [],
  formStep: "basic",   // basic | content | sop | media
  caseDetailId: null,
  caseMediaTab: "",
  message: "",
  deliveryFilters: { q: "", owner: "", city: "", dateLabel: "" },
  auditLogs: [],
  auditUserSummary: [],
  auditPagination: { page: 1, pageSize: 30, total: 0, totalPages: 1 },
  auditFilters: { q: "", action: "", resourceType: "", userId: "", from: "", to: "" },
  sessionToken: localStorage.getItem(AUTH_TOKEN_KEY) || ""
};

// ---- 工具 ----
function esc(v) {
  return String(v ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

async function api(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.sessionToken && !headers.Authorization) headers.Authorization = `Bearer ${state.sessionToken}`;
  const res = await fetch(apiUrl(url), {
    ...opts,
    credentials: SILVER_PUBLIC_MODE ? "include" : "same-origin",
    headers,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return normalizeUrls(data);
}

function apiUrl(url) {
  if (!SILVER_PUBLIC_MODE || /^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/api/")) return SILVER_API_BASE + url.slice(4);
  if (url.startsWith("/uploads/")) return SILVER_API_BASE + url;
  return url;
}

function publicUrl(url) {
  const raw = String(url || "");
  if (!raw || !SILVER_PUBLIC_MODE) return raw;
  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) return raw;
  if (raw.startsWith("/uploads/")) return SILVER_API_BASE + raw;
  if (raw.startsWith("/assets/")) return SILVER_FRONT_BASE + raw;
  return raw;
}

function normalizeUrls(value) {
  if (Array.isArray(value)) return value.map(normalizeUrls);
  if (!value || typeof value !== "object") return value;
  Object.keys(value).forEach((key) => {
    const item = value[key];
    if (typeof item === "string" && /(^url$|url$|cover$|image$|images$|banner|banners)/i.test(key)) {
      value[key] = publicUrl(item);
    } else {
      value[key] = normalizeUrls(item);
    }
  });
  return value;
}

function fallbackCover() {
  return SILVER_FRONT_BASE + "/assets/people/cn-social-cafe.jpg";
}

function imageUrl(url) {
  return publicUrl(url) || fallbackCover();
}

function homeHref() { return SILVER_PUBLIC_MODE ? SILVER_FRONT_BASE + "/" : "/"; }
function activityHref(id) {
  return SILVER_PUBLIC_MODE
    ? SILVER_FRONT_BASE + "/index.html?activity=" + encodeURIComponent(id)
    : "/activity/" + encodeURIComponent(id);
}

function flash(msg, type = "success") {
  state.message = `<div class="message ${type}">${esc(msg)}</div>`;
}
function clearFlash() { state.message = ""; }

function lines(v) { return Array.isArray(v) ? v.join("\n") : String(v || ""); }
function parseLines(v) { return String(v || "").split("\n").map(x => x.trim()).filter(Boolean); }

function roleLabel(r) {
  return { admin:"总部管理员", operator:"城市主理人", viewer:"只读账号", member:"普通学习用户", guest:"游客" }[r] || r;
}

function statusLabel(s) {
  return { published:"已发布", pending:"待审核", draft:"草稿", rejected:"已驳回" }[s] || s || "草稿";
}

function statusTagHtml(s) {
  const cls = { published:"published", pending:"pending", draft:"draft", rejected:"rejected" }[s] || "draft";
  return `<span class="status-tag ${cls}">${statusLabel(s)}</span>`;
}

// ---- 登录页 ----
function showLogin(error = "") {
  adminApp.innerHTML = `
    <section class="login-shell">
      <div class="login-visual">
        <h1>活动 SOP<br>管理后台</h1>
        <p>上架活动方案、管理素材资源、控制用户权限，<br>让全国主理人都能快速找到并执行好活动。</p>
      </div>
      <div class="login-panel">
        <div class="login-card">
          <h2>登录后台</h2>
          ${error ? `<div class="message error" style="margin-bottom:14px">${esc(error)}</div>` : ""}
          <form id="loginForm" style="display:flex;flex-direction:column;gap:14px">
            <div class="field"><label>账号</label><input class="input" id="username" value="admin" autocomplete="username"></div>
            <div class="field"><label>密码</label><input class="input" id="password" type="password" autocomplete="current-password"></div>
            <button class="btn" type="submit" style="margin-top:4px">进入后台</button>
          </form>
        </div>
      </div>
    </section>`;
  document.querySelector("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const data = await api("/api/login", { method:"POST", body:{
        username: document.querySelector("#username").value.trim(),
        password: document.querySelector("#password").value
      }});
      state.user = data.user;
      if (data.token) { state.sessionToken = data.token; localStorage.setItem(AUTH_TOKEN_KEY, data.token); }
      if (state.user.role !== "admin") { window.location.replace(homeHref()); return; }
      await refreshData();
      renderShell();
    } catch (err) { showLogin(err.message); }
  });
}

// ---- 数据刷新 ----
async function refreshData() {
  const isAdmin = state.user?.role === "admin";
  const [activityResult, userResult, projectResult, auditResult] = await Promise.all([
    api("/api/admin/activities"),
    isAdmin ? api("/api/admin/users") : Promise.resolve({ users: [] }),
    isAdmin ? api("/api/admin/activity-projects") : Promise.resolve({ projects: [] }),
    isAdmin ? api("/api/admin/audit-summary") : Promise.resolve({ summaries: [] })
  ]);
  state.activities = activityResult.activities || [];
  state.auditSummary = auditResult.summaries || [];
  if (isAdmin) {
    state.users = userResult.users || [];
    state.activityProjects = (projectResult.projects || []).map(applyAuditCountsToProject);
    state.activities = state.activities.map(applyAuditCountsToActivity);
  }
}

function auditSummaryCount(resourceType, resourceId, action, mediaIndex) {
  const items = (state.auditSummary || []).filter(x =>
    x.resourceType === resourceType && x.resourceId === resourceId && x.action === action
      && (mediaIndex === undefined || (mediaIndex === null ? x.mediaIndex === null : Number(x.mediaIndex) === Number(mediaIndex)))
  );
  return items.reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function projectAuditCount(project, action) {
  return (state.auditSummary || [])
    .filter(x => x.resourceType === "activity_project_media" && x.resourceId === project.id && x.action === action)
    .reduce((sum, x) => sum + Number(x.count || 0), 0);
}

function applyAuditCountsToActivity(activity) {
  return {
    ...activity,
    viewCount: auditSummaryCount("activity", activity.id, "view"),
    downloadCount: auditSummaryCount("activity_sop", activity.id, "download")
  };
}

function applyAuditCountsToProject(project) {
  return {
    ...project,
    viewCount: projectAuditCount(project, "view"),
    downloadCount: projectAuditCount(project, "download")
  };
}

// ---- 主框架 ----
function renderShell() {
  const u = state.user;
  const isAdmin = u.role === "admin";
  const notViewer = u.role !== "viewer";
  const navBadge = n => n > 0
    ? `<span style="display:inline-block;min-width:18px;height:18px;line-height:18px;text-align:center;background:#e8462c;color:#fff;border-radius:9px;font-size:11px;margin-left:6px;padding:0 5px;font-weight:600">${n}</span>`
    : "";
  const pendingBadge = navBadge((state.activities || []).filter(x => x.status === "pending").length);
  const userBadge = navBadge((state.users || []).filter(x => x.status === "disabled").length);
  const projectBadge = navBadge((state.activityProjects || []).filter(x => !x.sourceCaseId && (x.media || []).length).length);

  adminApp.innerHTML = `
    <section class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-dot"></div>
          <strong>开开华彩后台</strong>
          <span>${esc(u.name || u.username)} · ${esc(roleLabel(u.role))}</span>
        </div>
        <nav class="nav">
          <span class="nav-section-label">内容管理</span>
          <button data-tab="activities" class="${state.activeTab==="activities"?"active":""}">
            <span class="nav-icon">📋</span>活动方案
          </button>
          ${notViewer ? `<button data-tab="import" class="${state.activeTab==="import"?"active":""}">
            <span class="nav-icon">📥</span>导入审核${pendingBadge}
          </button>` : ""}
          ${isAdmin ? `<button data-tab="cases" class="${state.activeTab==="cases"?"active":""}">
            <span class="nav-icon">🎬</span>案例管理
          </button>` : ""}
          ${isAdmin ? `<button data-tab="delivery" class="${state.activeTab==="delivery"?"active":""}">
            <span class="nav-icon">📸</span>活动交付${projectBadge}
          </button>` : ""}
          <button data-tab="preview" class="${state.activeTab==="preview"?"active":""}">
            <span class="nav-icon">🔗</span>前台链接
          </button>
          ${isAdmin ? `<span class="nav-section-label">系统</span>
          <button data-tab="posts" class="${state.activeTab==="posts"?"active":""}">
            <span class="nav-icon">💬</span>留言管理
          </button>
          <button data-tab="homepage" class="${state.activeTab==="homepage"?"active":""}">
            <span class="nav-icon">🏠</span>首页设置
          </button>
          <button data-tab="users" class="${state.activeTab==="users"?"active":""}">
            <span class="nav-icon">👥</span>账号权限${userBadge}
          </button>` : ""}
          ${isAdmin ? `<button data-tab="audit" class="${state.activeTab==="audit"?"active":""}">
            <span class="nav-icon">🧾</span>访问日志
          </button>` : ""}
        </nav>
        <div class="side-foot">
          <a class="btn secondary small" href="${homeHref()}" target="_blank" style="margin-bottom:8px;display:flex">🌐 打开前台</a>
          <button class="btn ghost" id="logoutBtn" style="width:100%">退出登录</button>
        </div>
      </aside>
      <main class="main">
        <div id="content"></div>
      </main>
    </section>`;

  document.querySelectorAll("[data-tab]").forEach(btn =>
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab; clearFlash(); renderShell();
    }));
  document.querySelector("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method:"POST", body:{} });
    state.user = null; state.sessionToken = ""; localStorage.removeItem(AUTH_TOKEN_KEY); showLogin();
  });
  renderContent();
}

function renderContent() {
  if (state.activeTab === "posts") renderPosts();
  else if (state.activeTab === "homepage") renderHomepage();
  else if (state.activeTab === "users") renderUsers();
  else if (state.activeTab === "import") renderImport();
  else if (state.activeTab === "preview") renderPreview();
  else if (state.activeTab === "cases") renderCasesAdmin();
  else if (state.activeTab === "delivery") renderDeliveryProjects();
  else if (state.activeTab === "audit") renderAuditLogs();
  else renderActivities();
}

function openDeliveryProject(projectId) {
  state.activeTab = "delivery";
  state.caseDetailId = null;
  state.caseEdit = null;
  state.caseMediaTab = "";
  clearFlash();
  renderShell();
  setTimeout(() => {
    const card = [...document.querySelectorAll("[data-delivery-project]")].find(el => el.dataset.deliveryProject === String(projectId));
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 0);
}

// ---- 访问日志 ----
const AUDIT_ACTION_LABELS = { view: "观看", download: "下载" };
const AUDIT_RESOURCE_LABELS = {
  activity: "活动方案页面",
  case: "精彩案例页面",
  activity_project_media: "活动相册素材",
  case_media: "精彩案例素材",
  activity_sop: "活动 SOP"
};

function auditTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
}

function auditDateBoundary(value, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  const suffix = end ? "T23:59:59.999+08:00" : "T00:00:00.000+08:00";
  return new Date(`${value}${suffix}`).toISOString();
}

function auditActor(row) {
  const label = row.userName || row.username || "游客";
  return `<strong>${esc(label)}</strong><small>@${esc(row.username || "guest")} · ${esc(roleLabel(row.role || "guest"))}</small>`;
}

function auditSubject(row) {
  const resource = AUDIT_RESOURCE_LABELS[row.resourceType] || row.resourceType || "资源";
  const hasMediaIndex = row.mediaIndex !== null && row.mediaIndex !== undefined && row.mediaIndex !== ""
    && Number.isInteger(Number(row.mediaIndex));
  const position = hasMediaIndex ? ` · 第${Number(row.mediaIndex) + 1}个` : "";
  return `<strong>${esc(row.resourceTitle || "未命名资源")}</strong><small>${esc(resource)}${esc(position)}</small>`;
}

async function loadAuditLogs(page = state.auditPagination.page || 1) {
  const f = state.auditFilters;
  const params = new URLSearchParams({ page: String(page), pageSize: String(state.auditPagination.pageSize || 30) });
  if (f.q) params.set("q", f.q);
  if (f.action) params.set("action", f.action);
  if (f.resourceType) params.set("resourceType", f.resourceType);
  if (f.userId) params.set("userId", f.userId);
  const from = auditDateBoundary(f.from);
  const to = auditDateBoundary(f.to, true);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const body = document.querySelector("#auditLogsBody");
  if (body) body.innerHTML = `<div class="audit-loading">正在加载日志…</div>`;
  try {
    const data = await api(`/api/admin/audit-logs?${params.toString()}`);
    state.auditLogs = data.logs || [];
    state.auditUserSummary = data.summaryByUser || [];
    state.auditPagination = data.pagination || { page, pageSize: 30, total: 0, totalPages: 1 };
    state.auditError = "";
  } catch (err) {
    state.auditLogs = [];
    state.auditUserSummary = [];
    state.auditPagination = { page, pageSize: state.auditPagination.pageSize || 30, total: 0, totalPages: 1 };
    state.auditError = err.message || "日志加载失败";
  }
  if (state.activeTab === "audit") renderAuditLogBody();
}

function renderAuditLogs() {
  const content = document.querySelector("#content");
  const userOptions = (state.users || [])
    .slice()
    .sort((a, b) => String(a.username || "").localeCompare(String(b.username || "")))
    .map(u => `<option value="${esc(u.id)}" ${state.auditFilters.userId === u.id ? "selected" : ""}>${esc(u.name || u.username)} @${esc(u.username)}</option>`)
    .join("");
  const f = state.auditFilters;
  content.innerHTML = `
    <div class="topbar"><div><h1>访问日志</h1><p>记录每个账号观看、下载活动素材和 SOP 的操作，游客访问会标记为“游客”。</p></div></div>
    <div class="content-area">
      <div class="panel audit-filter-panel">
        <div class="panel-header"><div><h2>筛选日志</h2><p>可按账号、动作、资源和时间范围定位记录</p></div><button class="btn ghost small" type="button" id="auditClearBtn">清除筛选</button></div>
        <form id="auditFilterForm" class="audit-filter-grid">
          <label><span>关键词</span><input class="input" name="q" value="${esc(f.q)}" placeholder="账号 / 活动 / 文件名 / IP"></label>
          <label><span>动作</span><select class="select" name="action"><option value="">全部动作</option><option value="view" ${f.action === "view" ? "selected" : ""}>观看</option><option value="download" ${f.action === "download" ? "selected" : ""}>下载</option></select></label>
          <label><span>资源类型</span><select class="select" name="resourceType"><option value="">全部资源</option><option value="activity" ${f.resourceType === "activity" ? "selected" : ""}>活动方案页面</option><option value="activity_sop" ${f.resourceType === "activity_sop" ? "selected" : ""}>活动 SOP</option><option value="activity_project_media" ${f.resourceType === "activity_project_media" ? "selected" : ""}>活动相册素材</option><option value="case" ${f.resourceType === "case" ? "selected" : ""}>精彩案例页面</option><option value="case_media" ${f.resourceType === "case_media" ? "selected" : ""}>精彩案例素材</option></select></label>
          <label><span>账号</span><select class="select" name="userId"><option value="">全部账号</option>${userOptions}</select></label>
          <label><span>开始日期</span><input class="input" type="date" name="from" value="${esc(f.from)}"></label>
          <label><span>结束日期</span><input class="input" type="date" name="to" value="${esc(f.to)}"></label>
          <div class="audit-filter-actions"><button class="btn" type="submit">查询日志</button></div>
        </form>
      </div>
      <div id="auditLogsBody"></div>
    </div>`;
  document.querySelector("#auditFilterForm")?.addEventListener("submit", e => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    state.auditFilters = {
      q: String(form.get("q") || "").trim(), action: String(form.get("action") || ""),
      resourceType: String(form.get("resourceType") || ""), userId: String(form.get("userId") || ""),
      from: String(form.get("from") || ""), to: String(form.get("to") || "")
    };
    state.auditPagination.page = 1;
    loadAuditLogs(1);
  });
  document.querySelector("#auditClearBtn")?.addEventListener("click", () => {
    state.auditFilters = { q: "", action: "", resourceType: "", userId: "", from: "", to: "" };
    state.auditPagination.page = 1;
    renderAuditLogs();
  });
  loadAuditLogs(state.auditPagination.page || 1);
}

function renderAuditLogBody() {
  const body = document.querySelector("#auditLogsBody");
  if (!body) return;
  if (state.auditError) {
    body.innerHTML = `<div class="panel"><div class="audit-empty">${esc(state.auditError)}</div></div>`;
    return;
  }
  const p = state.auditPagination || { page: 1, pageSize: 30, total: 0, totalPages: 1 };
  const summary = state.auditUserSummary || [];
  const views = summary.reduce((sum, x) => sum + Number(x.viewCount || 0), 0);
  const downloads = summary.reduce((sum, x) => sum + Number(x.downloadCount || 0), 0);
  const actors = summary.length;
  const rows = state.auditLogs.map(row => `
    <tr>
      <td class="audit-time">${esc(auditTime(row.createdAt))}</td>
      <td class="audit-actor">${auditActor(row)}</td>
      <td><span class="audit-action ${esc(row.action)}">${esc(AUDIT_ACTION_LABELS[row.action] || row.action)}</span></td>
      <td class="audit-subject">${auditSubject(row)}</td>
      <td class="audit-file" title="${esc(row.filename || "")}">${esc(row.filename || "-")}</td>
      <td class="audit-ip" title="${esc(row.userAgent || "")}">${esc(row.ipAddress || "-")}</td>
    </tr>`).join("");
  body.innerHTML = `
    <div class="stat-cards audit-stats">
      <div class="stat-card"><span>筛选结果</span><strong>${p.total}</strong><em>条记录</em></div>
      <div class="stat-card"><span>筛选范围观看</span><strong>${views}</strong><em>次</em></div>
      <div class="stat-card"><span>筛选范围下载</span><strong>${downloads}</strong><em>次</em></div>
      <div class="stat-card"><span>涉及账号</span><strong>${actors}</strong><em>个主体</em></div>
    </div>
    <div class="panel audit-summary-panel">
      <div class="panel-header"><div><h2>账号汇总</h2><p>按当前关键词、动作、资源和日期筛选后的完整结果汇总</p></div></div>
      <div class="audit-table-wrap">${summary.length ? `<table class="table audit-table audit-account-table"><thead><tr><th>账号</th><th>角色</th><th>观看次数</th><th>下载次数</th><th>合计</th></tr></thead><tbody>${summary.map(row => `<tr><td class="audit-actor">${auditActor(row)}</td><td>${esc(roleLabel(row.role || "guest"))}</td><td><strong>${Number(row.viewCount || 0)}</strong></td><td><strong>${Number(row.downloadCount || 0)}</strong></td><td>${Number(row.totalCount || 0)}</td></tr>`).join("")}</tbody></table>` : `<div class="audit-empty">当前筛选条件下暂无账号汇总。</div>`}</div>
    </div>
    <div class="panel audit-log-panel">
      <div class="panel-header"><h2>操作明细</h2><span class="audit-page-note">第 ${p.page} / ${p.totalPages} 页，共 ${p.total} 条</span></div>
      <div class="audit-table-wrap">${rows ? `<table class="table audit-table"><thead><tr><th>时间</th><th>账号</th><th>动作</th><th>资源</th><th>文件名</th><th>IP / 设备</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="audit-empty">当前筛选条件下暂无记录。</div>`}</div>
      <div class="audit-pager"><button class="btn secondary small" type="button" id="auditPrevBtn" ${p.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${p.page} / ${p.totalPages} 页</span><button class="btn secondary small" type="button" id="auditNextBtn" ${p.page >= p.totalPages ? "disabled" : ""}>下一页</button></div>
    </div>`;
  document.querySelector("#auditPrevBtn")?.addEventListener("click", () => loadAuditLogs(Math.max(1, p.page - 1)));
  document.querySelector("#auditNextBtn")?.addEventListener("click", () => loadAuditLogs(Math.min(p.totalPages, p.page + 1)));
}

// ---- 活动管理主页 ----
function emptyActivity() {
  return {
    status:"published", title:"", city:"同城模板", region:"全国通用",
    category:"", activityType:"", price:"", capacity:"", duration:"", location:"",
    cover:"", images:[], videos:[], references:[], tags:[],
    intro:"", highlights:[], schedule:[],
    plan:{ target:"", materials:"", staffing:"", conversion:"", risk:"" },
    downloadEnabled:true, reviewNote:"", contact:"评论区留言，主理人联系您"
  };
}

function currentActivity() {
  const base = state.activities.find(x => x.id === state.editingId) || emptyActivity();
  return loadDraftToActivity(base);
}


function saveFormToState() {
  const f = document.querySelector("#activityForm");
  if (!f) return;
  const fd = new FormData(f);
  state.draft = state.draft || {};
  for (const [k, v] of fd.entries()) state.draft[k] = v;
  state.draft._tags = [...state.tags];
  state.draft._scheduleRows = state.scheduleRows.map(x => ({...x}));
  state.draft._imageUrls = [...state.imageUrls];
}

function loadDraftToActivity(a) {
  if (!state.draft) return a;
  const d = state.draft;
  return {
    ...a,
    status: d.status || a.status,
    title: d.title ?? a.title,
    city: d.city ?? a.city,
    region: d.region ?? a.region,
    category: d.category ?? a.category,
    activityType: d.activityType ?? a.activityType,
    price: d.price ?? a.price,
    capacity: d.capacity ?? a.capacity,
    duration: d.duration ?? a.duration,
    location: d.location ?? a.location,
    contact: d.contact ?? a.contact,
    intro: d.intro ?? a.intro,
    highlights: d.highlights ?? (Array.isArray(a.highlights) ? a.highlights.join("\n") : a.highlights),
    tags: d._tags || a.tags,
    schedule: d._scheduleRows || a.schedule,
    images: d._imageUrls || a.images,
    cover: d.cover ?? a.cover,
    videos: d.videos ?? (Array.isArray(a.videos) ? a.videos.join("\n") : a.videos),
    references: d.references ?? (Array.isArray(a.references) ? a.references.join("\n") : a.references),
    plan: {
      target: d.target ?? a.plan?.target,
      materials: d.materials ?? a.plan?.materials,
      staffing: d.staffing ?? a.plan?.staffing,
      conversion: d.conversion ?? a.plan?.conversion,
      risk: d.risk ?? a.plan?.risk,
    },
    reviewNote: d.reviewNote ?? a.reviewNote,
    downloadEnabled: d.downloadEnabled ? d.downloadEnabled === "on" : a.downloadEnabled,
  };
}

// 把 AI 解析出的活动灌进「新建活动」表单（草稿，未保存）
function applyParsedActivity(p) {
  p = p || {};
  const pl = p.plan || {};
  state.editingId = null;
  state.draft = {
    status: "draft",
    title: p.title || "",
    city: p.city || "同城模板",
    region: p.region || "",
    category: p.category || "",
    activityType: p.activityType || "",
    price: p.price || "",
    capacity: p.capacity || "",
    duration: p.duration || "",
    location: p.location || "",
    contact: p.contact || "",
    intro: p.intro || "",
    highlights: (p.highlights || []).join("\n"),
    target: pl.target || "",
    materials: pl.materials || "",
    staffing: pl.staffing || "",
    conversion: pl.conversion || "",
    risk: pl.risk || "",
    _tags: p.tags || [],
    _scheduleRows: (p.schedule || []).map(x => ({ time: x.time || "", item: x.item || "" })),
    _imageUrls: []
  };
  state._formForId = "__ai_prefill__"; // 强制重新播种 tags/schedule/images
  state.activeTab = "activities";
  state.formStep = "basic";
  renderShell();
}

function renderActivities() {
  const content = document.querySelector("#content");
  const a = currentActivity();
  if (state._formForId !== state.editingId) {
    state._formForId = state.editingId;
    state.imageUrls = Array.isArray(a.images) ? [...a.images] : [];
    state.scheduleRows = Array.isArray(a.schedule) ? a.schedule.map(x => ({...x})) : [];
    state.tags = Array.isArray(a.tags) ? [...a.tags] : [];
  }

  const published = state.activities.filter(x => x.status === "published").length;
  const pending = state.activities.filter(x => x.status === "pending").length;

  const canEdit = state.user.role !== "viewer";
  const dis = canEdit ? "" : "disabled";

  content.innerHTML = `
    <div class="topbar">
      <div>
        <h1>活动方案</h1>
        <p>管理所有活动内容，点击左侧列表可编辑，右侧表单分步填写。</p>
      </div>
      ${canEdit ? `<button class="btn" id="newActivityBtn">＋ 新建活动</button>` : ""}
    </div>
    <div class="content-area">
      ${state.message}

      <!-- 统计 -->
      <div class="stat-cards">
        <div class="stat-card"><span>全部活动</span><strong>${state.activities.length}</strong></div>
        <div class="stat-card"><span>已发布</span><strong>${published}</strong><em>对外可见</em></div>
        <div class="stat-card"><span>待审核</span><strong>${pending}</strong>${pending>0?`<em>需要处理</em>`:""}</div>
        <div class="stat-card"><span>当前编辑</span><strong>${state.editingId ? "编辑中" : "新建"}</strong></div>
      </div>

      <div style="display:grid;grid-template-columns:320px 1fr;gap:16px;align-items:start">

        <!-- 左：活动列表 -->
        <div class="panel">
          <div class="panel-header">
            <h2>活动列表</h2>
            <span style="font-size:12px;color:var(--muted)">共 ${state.activities.length} 个</span>
          </div>
          <div style="padding:12px 12px 24px;height:calc(100vh - 300px);overflow-y:auto" class="act-scroll">
            <div class="activity-list">
              ${state.activities.map(act => `
                <div class="activity-row ${act.id === state.editingId ? "editing" : ""}" data-edit="${esc(act.id)}">
                  <img src="${esc(imageUrl(act.cover))}" alt="">
                  <div class="activity-row-info">
                    <h3>${esc(act.title)}</h3>
                    <div class="activity-row-meta">
                      <span>${esc(act.city || "同城")}</span>
                      <span>·</span>
                      ${statusTagHtml(act.status)}
                    </div>
                    <div style="font-size:11px;color:var(--hint);margin-top:2px">${esc(act.price || "价格待定")}</div>
                    <div class="audit-counts"><span>查看 ${Number(act.viewCount || 0)}</span><span>下载 ${Number(act.downloadCount || 0)}</span></div>
                  </div>
                  <div class="activity-row-actions">
                    <a class="btn secondary small" href="${activityHref(act.id)}" target="_blank">预览</a>
                    ${canEdit ? `<button class="btn danger small" data-delete="${esc(act.id)}">删除</button>` : ""}
                  </div>
                </div>`).join("") || `<div style="text-align:center;padding:32px;color:var(--muted);font-size:13px">暂无活动，点击新建</div>`}
            </div>
          </div>
        </div>

        <!-- 右：编辑表单 -->
        <div class="panel" id="editPanel">
          <div class="panel-header">
            <h2>${state.editingId ? "✏️ 编辑活动" : "＋ 新建活动"}</h2>
            <div style="display:flex;gap:6px">
              ${state.editingId ? `<a class="btn secondary small" href="${activityHref(state.editingId)}" target="_blank">预览页面</a>` : ""}
              ${canEdit ? `<button class="btn secondary small" id="resetFormBtn">清空</button>` : ""}
            </div>
          </div>

          <!-- 步骤 Tab -->
          <div class="form-tabs">
            <button class="form-tab ${state.formStep==="basic"?"active":""}" data-step="basic">
              <span class="form-tab-num">1</span>基本信息
            </button>
            <button class="form-tab ${state.formStep==="content"?"active":""}" data-step="content">
              <span class="form-tab-num">2</span>活动内容
            </button>
            <button class="form-tab ${state.formStep==="sop"?"active":""}" data-step="sop">
              <span class="form-tab-num">3</span>执行方案
            </button>
            <button class="form-tab ${state.formStep==="media"?"active":""}" data-step="media">
              <span class="form-tab-num">4</span>素材&设置
            </button>
          </div>

          <form id="activityForm">

            <!-- Step 1: 基本信息 -->
            <div class="form-pane ${state.formStep==="basic"?"active":""}" id="pane-basic">
              <div class="form-section-title">分类与状态</div>
              <div class="row three">
                <div class="field">
                  <label>发布状态</label>
                  <select class="select" name="status" ${dis}>
                    <option value="published" ${a.status==="published"?"selected":""}>✅ 已发布</option>
                    <option value="draft" ${a.status==="draft"?"selected":""}>📝 草稿</option>
                    <option value="pending" ${a.status==="pending"?"selected":""}>⏳ 待审核</option>
                    <option value="rejected" ${a.status==="rejected"?"selected":""}>❌ 已驳回</option>
                  </select>
                </div>
                <div class="field">
                  <label>所属城市</label>
                  <input class="input" name="city" value="${esc(a.city)}" placeholder="例如：北京" ${dis}>
                </div>
                <div class="field">
                  <label>地区备注</label>
                  <input class="input" name="region" value="${esc(a.region||a.city)}" placeholder="例如：朝阳区" ${dis}>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <label>活动大类</label>
                  <input class="input" name="category" value="${esc(a.category)}" placeholder="例如：同城社交与情感系列" ${dis}>
                </div>
                <div class="field">
                  <label>细分活动类型</label>
                  <input class="input" name="activityType" value="${esc(a.activityType)}" placeholder="例如：KTV欢唱、掼蛋、旗袍走秀" ${dis}>
                </div>
              </div>
              <div class="form-section-title">活动基础信息</div>
              <div class="field">
                <label>活动标题 *</label>
                <input class="input" name="title" value="${esc(a.title)}" placeholder="简洁有力，10字以内最佳" required ${dis}>
              </div>
              <div class="field">
                <label>活动简介</label>
                <textarea class="textarea" name="intro" placeholder="一段话说清楚这个活动是什么、适合谁、体验感是什么" ${dis}>${esc(a.intro)}</textarea>
              </div>
              <div class="row four">
                <div class="field">
                  <label>参考价格</label>
                  <input class="input" name="price" value="${esc(a.price)}" placeholder="例如：69元/人" ${dis}>
                </div>
                <div class="field">
                  <label>适合人数</label>
                  <input class="input" name="capacity" value="${esc(a.capacity)}" placeholder="例如：20-40人" ${dis}>
                </div>
                <div class="field">
                  <label>活动时长</label>
                  <input class="input" name="duration" value="${esc(a.duration)}" placeholder="例如：3小时" ${dis}>
                </div>
                <div class="field">
                  <label>推荐地点</label>
                  <input class="input" name="location" value="${esc(a.location)}" placeholder="例如：同城KTV包厢" ${dis}>
                </div>
              </div>
              <div class="field">
                <label>报名/咨询提示</label>
                <input class="input" name="contact" value="${esc(a.contact)}" placeholder="显示在详情页底部" ${dis}>
              </div>
            </div>

            <!-- Step 2: 活动内容 -->
            <div class="form-pane ${state.formStep==="content"?"active":""}" id="pane-content">
              <div class="form-section-title">活动亮点</div>
              <div class="field">
                <label>活动亮点（每行一条）</label>
                <textarea class="textarea" name="highlights" placeholder="大字歌单&#10;副歌高光录制&#10;活动后群内作品发布" ${dis}>${esc(lines(a.highlights))}</textarea>
                <span class="help">每行一条亮点，展示在详情页介绍区</span>
              </div>
              <div class="form-section-title">当日活动时间轴</div>
              <div class="field">
                <label>活动时间轴</label>
                <div class="schedule-editor" id="scheduleEditor">
                  ${renderScheduleRows(canEdit)}
                </div>
                ${canEdit ? `<button class="add-row-btn" type="button" id="addScheduleRow">＋ 添加时间节点</button>` : ""}
              </div>
              <div class="form-section-title">标签</div>
              <div class="field">
                <label>活动标签（回车添加）</label>
                <div class="tags-editor" id="tagsEditor">
                  ${renderTagChips(canEdit)}
                  ${canEdit ? `<input class="tag-input" id="tagInput" placeholder="输入标签，回车添加…">` : ""}
                </div>
                <span class="help">展示在活动卡片和详情页，方便主理人筛选</span>
              </div>
            </div>

            <!-- Step 3: 执行方案 SOP -->
            <div class="form-pane ${state.formStep==="sop"?"active":""}" id="pane-sop">
              <div class="form-section-title">活动执行包</div>
              <div class="row">
                <div class="field">
                  <label>🎯 活动定位与转化目标</label>
                  <textarea class="textarea short" name="target" placeholder="活动定位、适合人群、价格/规模、核心转化目标" ${dis}>${esc(a.plan?.target)}</textarea>
                </div>
                <div class="field">
                  <label>📦 所需物料</label>
                  <textarea class="textarea short" name="materials" placeholder="通用物料、活动专属物料、内容拍摄物料、转化承接物料" ${dis}>${esc(a.plan?.materials)}</textarea>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <label>👥 人员分工</label>
                  <textarea class="textarea short" name="staffing" placeholder="主理人、主持/老师、签到、摄影、后勤、转化跟进分别负责什么" ${dis}>${esc(a.plan?.staffing)}</textarea>
                </div>
                <div class="field">
                  <label>🔄 话术与转化承接</label>
                  <textarea class="textarea short" name="conversion" placeholder="活动前沟通、活动中主持/转化话术、活动后私聊和群内承接" ${dis}>${esc(a.plan?.conversion)}</textarea>
                </div>
              </div>
              <div class="field">
                <label>⚠️ 注意事项与风险预案</label>
                <textarea class="textarea short" name="risk" placeholder="客户体验注意事项、安全预案、转化边界、内容沉淀要求、复盘要求" ${dis}>${esc(a.plan?.risk)}</textarea>
              </div>
              <div class="form-section-title">审核信息</div>
              <div class="field">
                <label>审核备注</label>
                <input class="input" name="reviewNote" value="${esc(a.reviewNote)}" placeholder="例如：图片待补充、视频链接待确认" ${dis}>
              </div>
            </div>

            <!-- Step 4: 素材与设置 -->
            <div class="form-pane ${state.formStep==="media"?"active":""}" id="pane-media">
              <div class="form-section-title">活动图片</div>
              <div class="images-area">
                ${canEdit ? `
                <label class="image-upload-zone" for="imageInput">
                  <div class="upload-icon">📷</div>
                  <p>点击上传图片（支持多选）<br>第一张自动作为封面</p>
                  <input type="file" id="imageInput" accept="image/*" multiple style="display:none">
                </label>` : ""}
                <div class="thumbs-grid" id="imagePreview">${renderThumbs()}</div>
              </div>
              <div class="field">
                <label>封面图地址（可手动指定）</label>
                <input class="input" name="cover" id="coverInput" value="${esc(a.cover)}" placeholder="留空则自动使用第一张上传图片" ${dis}>
              </div>
              <input type="hidden" name="images" id="imagesInput" value="${esc(state.imageUrls.join("\n"))}">

              <div class="form-section-title">参考素材链接</div>
              <div class="row">
                <div class="field">
                  <label>视频参考链接（每行一个）</label>
                  <textarea class="textarea" name="videos" placeholder="可粘贴视频号、小程序或素材库链接" ${dis}>${esc(lines(a.videos))}</textarea>
                </div>
                <div class="field">
                  <label>方案参考链接（每行一个）</label>
                  <textarea class="textarea" name="references" placeholder="飞书文档、内部素材、方案链接" ${dis}>${esc(lines(a.references))}</textarea>
                </div>
              </div>

              <div class="form-section-title">下载权限</div>
              <label class="checkline">
                <input type="checkbox" name="downloadEnabled" ${a.downloadEnabled===false?"":"checked"} ${dis}>
                <span>允许有权限的用户导出可视化 SOP</span>
              </label>
            </div>

            <!-- 底部保存区 -->
            ${canEdit ? `
            <div class="form-actions">
              <button class="btn" type="submit">💾 保存活动</button>
              <div style="display:flex;gap:6px;margin-left:auto">
                <button class="form-tab-nav btn secondary small" type="button" data-dir="-1">← 上一步</button>
                <button class="form-tab-nav btn secondary small" type="button" data-dir="1">下一步 →</button>
              </div>
            </div>` : ""}
          </form>
        </div>

      </div>
    </div>`;

  bindActivityEvents();
}

function renderScheduleRows(canEdit) {
  if (!state.scheduleRows.length) state.scheduleRows = [{ time:"", item:"" }];
  return state.scheduleRows.map((row, i) => `
    <div class="schedule-row" data-row-idx="${i}">
      <input class="input" type="text" data-time placeholder="14:00" value="${esc(row.time)}" ${canEdit?"":"disabled"}>
      <input class="input" type="text" data-item placeholder="流程节点描述" value="${esc(row.item)}" ${canEdit?"":"disabled"}>
      ${canEdit ? `<button class="del-row-btn" type="button" data-del-row="${i}" title="删除">×</button>` : "<span></span>"}
    </div>`).join("");
}

function renderTagChips(canEdit) {
  return state.tags.map((tag, i) => `
    <span class="tag-chip">
      ${esc(tag)}
      ${canEdit ? `<button type="button" data-del-tag="${i}">×</button>` : ""}
    </span>`).join("");
}

function renderThumbs() {
  return state.imageUrls.map((url, i) => `
    <div class="thumb ${i===0?"cover-thumb":""}">
      <img src="${esc(publicUrl(url))}" alt="图${i+1}">
      <button class="thumb-del" type="button" data-remove-image="${i}" title="删除">×</button>
    </div>`).join("");
}

function syncImages() {
  const input = document.querySelector("#imagesInput");
  const cover = document.querySelector("#coverInput");
  const preview = document.querySelector("#imagePreview");
  if (input) input.value = state.imageUrls.join("\n");
  if (cover && !cover.value && state.imageUrls[0]) cover.value = state.imageUrls[0];
  if (preview) {
    preview.innerHTML = renderThumbs();
    preview.querySelectorAll("[data-remove-image]").forEach(btn =>
      btn.addEventListener("click", () => {
        state.imageUrls.splice(Number(btn.dataset.removeImage), 1);
        syncImages();
      }));
  }
}

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function uploadImageFile(file, endpoint = "/api/admin/upload-image") {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const res = await fetch(apiUrl(`${endpoint}?ext=${encodeURIComponent(ext)}`), {
    method: "POST",
    credentials: SILVER_PUBLIC_MODE ? "include" : "same-origin",
    body: file
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "图片上传失败");
  return normalizeUrls(data);
}

const STEPS = ["basic","content","sop","media"];

function bindActivityEvents() {
  // 新建
  document.querySelector("#newActivityBtn")?.addEventListener("click", () => {
    state.editingId = null; state.formStep = "basic"; state.draft = null; clearFlash(); renderActivities();
  });
  // 清空
  document.querySelector("#resetFormBtn")?.addEventListener("click", () => {
    state.editingId = null; state.formStep = "basic"; state.draft = null; clearFlash(); renderActivities();
  });
  // 点击列表编辑
  document.querySelectorAll(".activity-row[data-edit]").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest(".activity-row-actions")) return;
      state.editingId = row.dataset.edit; state.formStep = "basic"; state.draft = null; clearFlash(); renderActivities();
    });
  });
  // 删除
  document.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm("确认删除这个活动？删除后无法恢复。")) return;
      try {
        await api(`/api/admin/activities/${encodeURIComponent(btn.dataset.delete)}`, { method:"DELETE" });
        await refreshData(); state.editingId = null; flash("活动已删除"); renderActivities();
      } catch (err) { flash(err.message, "error"); renderActivities(); }
    });
  });
  // Step Tab 切换
  document.querySelectorAll("[data-step]").forEach(btn => {
    btn.addEventListener("click", () => { saveFormToState(); state.formStep = btn.dataset.step; renderActivities(); });
  });
  // 上下步骤按钮
  document.querySelectorAll(".form-tab-nav").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = STEPS.indexOf(state.formStep);
      const next = STEPS[idx + Number(btn.dataset.dir)];
      if (next) { saveFormToState(); state.formStep = next; renderActivities(); }
    });
  });
  // 流程行 添加/删除/输入
  document.querySelector("#addScheduleRow")?.addEventListener("click", () => {
    state.scheduleRows.push({ time:"", item:"" }); renderActivities();
    document.querySelector("[data-step='content']")?.click();
  });
  document.querySelectorAll("[data-del-row]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.scheduleRows.splice(Number(btn.dataset.delRow), 1);
      if (!state.scheduleRows.length) state.scheduleRows.push({ time:"", item:"" });
      renderActivities(); document.querySelector("[data-step='content']")?.click();
    });
  });
  document.querySelectorAll(".schedule-row").forEach(row => {
    const idx = Number(row.dataset.rowIdx);
    row.querySelector("[data-time]")?.addEventListener("input", e => { state.scheduleRows[idx].time = e.target.value; });
    row.querySelector("[data-item]")?.addEventListener("input", e => { state.scheduleRows[idx].item = e.target.value; });
  });
  // 标签输入
  const tagInput = document.querySelector("#tagInput");
  tagInput?.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const v = tagInput.value.trim().replace(/,$/, "");
      if (v && !state.tags.includes(v)) { state.tags.push(v); renderActivities(); document.querySelector("[data-step='content']")?.click(); }
    }
  });
  document.querySelectorAll("[data-del-tag]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.tags.splice(Number(btn.dataset.delTag), 1); renderActivities(); document.querySelector("[data-step='content']")?.click();
    });
  });
  // 图片上传
  syncImages();
  document.querySelector("#imageInput")?.addEventListener("change", async e => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      for (const file of files) {
        const data = await uploadImageFile(file);
        state.imageUrls.push(data.url);
      }
      syncImages(); flash(`已上传 ${files.length} 张图片`);
    } catch (err) { flash(err.message, "error"); }
    e.target.value = "";
  });
  // 保存表单
  document.querySelector("#activityForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // 从state取最新的流程/标签（textarea不参与）
    const schedule = state.scheduleRows.filter(x => x.item.trim()).map(x => ({ time:x.time.trim(), item:x.item.trim() }));
    const payload = {
      status:    f.get("status"),
      title:     f.get("title"),
      city:      f.get("city"),
      region:    f.get("region"),
      category:  f.get("category"),
      activityType: f.get("activityType"),
      price:     f.get("price"),
      capacity:  f.get("capacity"),
      duration:  f.get("duration"),
      location:  f.get("location"),
      contact:   f.get("contact"),
      intro:     f.get("intro"),
      highlights: parseLines(f.get("highlights")),
      schedule,
      tags: state.tags,
      cover: f.get("cover") || state.imageUrls[0] || "",
      images: state.imageUrls,
      videos: parseLines(f.get("videos")),
      references: parseLines(f.get("references")),
      target:    f.get("target"),
      materials: f.get("materials"),
      staffing:  f.get("staffing"),
      conversion:f.get("conversion"),
      risk:      f.get("risk"),
      downloadEnabled: f.get("downloadEnabled") === "on",
      reviewNote: f.get("reviewNote")
    };
    try {
      if (state.editingId) {
        await api(`/api/admin/activities/${encodeURIComponent(state.editingId)}`, { method:"PUT", body:payload });
        flash("✅ 活动已更新");
      } else {
        const data = await api("/api/admin/activities", { method:"POST", body:payload });
        state.editingId = data.activity.id;
        flash("✅ 活动已创建");
      }
      await refreshData(); state.draft = null; renderActivities();
    } catch (err) { flash(err.message, "error"); renderActivities(); }
  });
}


// ---- 首页设置 ----
// ---- 留言管理 ----


// ---- 留言管理 ----
let postsFilter = "pending";
async function renderPosts() {
  const main = document.querySelector("#content");
  main.innerHTML = '<div class="topbar"><div><h1>留言管理</h1><p>审核、删除用户在活动交流区发布的内容。</p></div></div><div id="postsAdminBody" style="padding:8px 32px 40px;max-width:1000px">加载中...</div>';
  let posts = [];
  try {
    const r = await api("/api/admin/posts");
    posts = r.posts || [];
  } catch (e) {
    document.querySelector("#postsAdminBody").innerHTML = '<p style="color:#c0392b">' + esc(e.message) + '</p>';
    return;
  }
  const pendingCount = posts.filter(p => (p.status || "approved") !== "approved").length;
  const filtered = postsFilter === "all" ? posts
    : postsFilter === "pending" ? posts.filter(p => (p.status || "approved") !== "approved")
    : posts.filter(p => (p.status || "approved") === "approved");
  const body = document.querySelector("#postsAdminBody");
  body.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:24px">
      <button class="btn ${postsFilter==="pending"?"":"secondary"}" data-pf="pending">待审核 (${pendingCount})</button>
      <button class="btn ${postsFilter==="approved"?"":"secondary"}" data-pf="approved">已通过</button>
      <button class="btn ${postsFilter==="all"?"":"secondary"}" data-pf="all">全部 (${posts.length})</button>
    </div>
    ${filtered.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:64px 0;font-size:16px">暂无留言</p>' : filtered.map(p => `
      <div style="background:var(--card,#fff);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <strong style="font-size:17px">${esc(p.author)}</strong>
          <span style="font-size:14px;color:var(--muted)">${esc(p.role||"")}</span>
          <span style="font-size:14px;color:var(--muted)">· ${esc(p.activityTitle||"")}</span>
          <span style="font-size:14px;color:var(--muted)">· ${esc((p.createdAt||"").slice(0,10))}</span>
          ${(p.status||"approved")!=="approved" ? '<span style="font-size:13px;color:#c8742c;background:#fdf3ea;padding:3px 11px;border-radius:11px">待审核</span>' : '<span style="font-size:13px;color:#2e7d32;background:#edf7ed;padding:3px 11px;border-radius:11px">已通过</span>'}
        </div>
        <div style="font-size:16px;line-height:1.85;margin-top:12px;white-space:pre-wrap">${esc(p.content)}</div>
        ${(p.images||[]).length ? '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">' + p.images.map(u => { const img = publicUrl(u); return `<img src="${esc(img)}" style="width:140px;height:105px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="window.open('${esc(img)}')">`; }).join("") + '</div>' : ''}
        <div style="display:flex;gap:10px;margin-top:18px">
          ${(p.status||"approved")!=="approved" ? `<button class="btn" data-pa="${esc(p.id)}" style="background:#2e7d32;color:#fff">✅ 通过</button>` : ''}
          <button class="btn secondary" data-pd="${esc(p.id)}" style="color:#c0392b;border-color:#c0392b">❌ 删除</button>
        </div>
      </div>`).join("")}
  `;
  body.querySelectorAll("[data-pf]").forEach(b => b.addEventListener("click", () => { postsFilter = b.dataset.pf; renderPosts(); }));
  body.querySelectorAll("[data-pa]").forEach(b => b.addEventListener("click", async () => {
    try { await api("/api/admin/posts/approve", { method:"POST", body:{ id: b.dataset.pa } }); flash("✅ 已通过"); renderPosts(); }
    catch (e) { flash(e.message, "error"); }
  }));
  body.querySelectorAll("[data-pd]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("确定删除这条留言？不可恢复。")) return;
    try { await api("/api/admin/posts/delete", { method:"POST", body:{ id: b.dataset.pd } }); flash("已删除"); renderPosts(); }
    catch (e) { flash(e.message, "error"); }
  }));
}

async function renderHomepage() {
  const content = document.querySelector("#content");
  const cfg = await api("/api/site-config");
  const c = cfg.config || {};
  const featuredIds = c.featuredIds || [];

  content.innerHTML = `
    <div class="topbar"><div><h1>首页设置</h1><p>配置首页展示内容，修改后立即生效。</p></div></div>
    <div class="content-area">
      ${state.message}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">

        <div class="panel">
          <div class="panel-header"><h2>📝 文字内容</h2></div>
          <div class="panel-body">
            <div class="field">
              <label>首页大标题</label>
              <textarea class="textarea" id="cfgTitle" style="min-height:80px">${esc(c.heroTitle||"")}</textarea>
            </div>
            <div class="field">
              <label>首页描述文字</label>
              <textarea class="textarea" id="cfgDesc">${esc(c.heroDesc||"")}</textarea>
            </div>
            <button class="btn" id="saveTextBtn">💾 保存文字</button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2>🖼️ 首页轮播图</h2>
            <span style="font-size:12px;color:var(--muted)">最多6张，每5秒自动切换</span>
          </div>
          <div class="panel-body">
            <div id="bannerList" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
              ${(c.banners||[]).map(url=>`
                <div style="position:relative;border-radius:8px;overflow:hidden">
                  <img src="${esc(publicUrl(url))}" style="width:100%;height:80px;object-fit:cover;display:block">
                  <button class="btn-del-banner" data-url="${esc(url)}" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px">✕</button>
                </div>`).join("")}
              ${(c.banners||[]).length < 6 ? `
                <label style="height:80px;border:2px dashed var(--line);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font-size:13px;flex-direction:column;gap:4px">
                  <span style="font-size:24px">+</span><span>上传图片</span>
                  <input type="file" id="bannerUpload" accept="image/*" style="display:none">
                </label>` : ""}
            </div>
            <p style="font-size:12px;color:var(--hint);margin:0 0 12px">已上传 ${(c.banners||[]).length}/6 张 · 建议尺寸 1200×500px</p>
            ${(c.banners||[]).length > 0 ? '<button class="btn" id="activateBannerBtn" style="width:100%">🚀 保存并启用轮播图</button>' : ""}
          </div>
        </div>
      </div>
    </div>`;

  document.querySelector("#saveTextBtn").addEventListener("click", async () => {
    try {
      await api("/api/admin/site-config", { method:"POST", body:{
        heroTitle: document.querySelector("#cfgTitle").value,
        heroDesc: document.querySelector("#cfgDesc").value
      }});
      flash("✅ 文字内容已保存"); renderHomepage();
    } catch(e) { flash(e.message,"error"); renderHomepage(); }
  });

  // 上传轮播图
  const bannerUpload = document.querySelector("#bannerUpload");
  if (bannerUpload) {
    bannerUpload.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await uploadImageFile(file, "/api/admin/banners/upload");
        flash("✅ 图片已上传"); renderHomepage();
      } catch(e) { flash(e.message,"error"); }
    });
  }
  const activateBtn = document.querySelector("#activateBannerBtn");
  if (activateBtn) {
    activateBtn.addEventListener("click", () => {
      flash("✅ 轮播图已保存并启用，刷新前台即可看到效果");
    });
  }
  // 删除轮播图
  document.querySelectorAll(".btn-del-banner").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await api("/api/admin/banners/delete", { method:"POST", body:{ url: btn.dataset.url }});
        flash("已删除"); renderHomepage();
      } catch(e) { flash(e.message,"error"); }
    });
  });
}

// ---- 案例管理 ----
const CASE_DEFAULT_CATS = ["俱乐部活动", "社群风采", "旅游线路"];

// api() 会把 /uploads/ 改写成绝对地址(域名模式),入库前必须还原为相对路径
function toRelativeUpload(u) {
  const s = String(u || "");
  if (typeof SILVER_API_BASE === "string" && SILVER_API_BASE && s.startsWith(SILVER_API_BASE)) {
    return s.slice(SILVER_API_BASE.length);
  }
  return s;
}

function emptyCase() {
  return { title:"", category:CASE_DEFAULT_CATS[0], city:"", dateLabel:"", description:"",
    cover:"", media:[], sortOrder:9999, status:"published" };
}

function casePlatformAdmin(url) {
  const u = String(url || "");
  if (/weixin|channels\.weixin|wx\./i.test(u)) return "视频号";
  if (/douyin|iesdouyin/i.test(u)) return "抖音";
  if (/xiaohongshu|xhslink/i.test(u)) return "小红书";
  return "外部链接";
}

function caseMediaLabelAdmin(m) {
  if (m.type === "image") return "图片";
  if (m.type === "video") return "视频文件";
  if (m.type === "document") return "文档素材";
  return casePlatformAdmin(m.url);
}

function caseMediaSortPreviewAdmin(m, i) {
  const poster = m.poster || m.thumbnailUrl || m.videoThumbnail || "";
  const typeLabel = caseMediaLabelAdmin(m);
  if (m.type === "image") {
    return `<img src="${esc(publicUrl(m.url))}" alt="${esc(typeLabel)}" loading="lazy">`;
  }
  if (m.type === "video") {
    return poster
      ? `<img src="${esc(publicUrl(poster))}" alt="视频缩略图" loading="lazy"><span class="case-edit-media-sort-play">▶</span>`
      : `<video class="case-edit-media-sort-video" data-thumb-src="${esc(publicUrl(m.url))}#t=0.5" muted playsinline preload="none"></video><span class="case-edit-media-sort-play">▶</span>`;
  }
  if (m.type === "document") {
    const ext = fileNameFromUrlAdmin(m.url).split(".").pop() || "DOC";
    return `<div class="case-edit-media-sort-doc"><strong>${esc(ext.slice(0, 4).toUpperCase())}</strong><small>文档</small></div>`;
  }
  return `<div class="case-edit-media-sort-link"><strong>↗</strong><small>${esc(typeLabel)}</small></div>`;
}

function groupedCaseMediaAdmin(c) {
  const groups = { videos: [], images: [], documents: [], links: [] };
  (c.media || []).forEach((m, index) => {
    const item = { ...m, index };
    if (m.type === "video") groups.videos.push(item);
    else if (m.type === "image") groups.images.push(item);
    else if (m.type === "document") groups.documents.push(item);
    else groups.links.push(item);
  });
  return groups;
}

function fileNameFromUrlAdmin(url) {
  try {
    const raw = String(url || "").split("?")[0].split("#")[0];
    return decodeURIComponent(raw.split("/").pop() || "");
  } catch {
    return String(url || "").split("?")[0].split("#")[0].split("/").pop() || "";
  }
}

function hydrateCaseAdminVideoThumbs() {
  const thumbs = Array.from(document.querySelectorAll(".case-admin-video-thumb[data-thumb-src], .case-edit-media-sort-video[data-thumb-src]"));
  const loadThumb = video => {
    if (!video || video.src || !video.dataset.thumbSrc) return;
    video.src = video.dataset.thumbSrc;
  };
  if (!("IntersectionObserver" in window)) {
    thumbs.slice(0, 12).forEach(loadThumb);
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      loadThumb(entry.target);
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "700px 0px" });
  thumbs.forEach(video => observer.observe(video));
}

function normalizeCaseAdminState(c) {
  return {
    ...c,
    cover: toRelativeUpload(c.cover),
    media: (c.media || []).map(m => ({ ...m, url: m.type === "link" ? m.url : toRelativeUpload(m.url) }))
  };
}

async function patchCaseAdmin(c, body, message) {
  const data = await api(`/api/admin/cases/${encodeURIComponent(c.id)}`, { method:"PATCH", body });
  if (data.case) {
    const nextCase = normalizeCaseAdminState(data.case);
    const idx = (state.adminCases || []).findIndex(x => x.id === nextCase.id);
    if (idx >= 0) state.adminCases[idx] = nextCase;
  }
  state.adminCasesLoaded = true;
  flash(message || "已更新");
  if (state.caseDetailId) renderCaseAdminDetail();
  else renderCasesAdmin();
}

function renderDeliveryProjects() {
  const content = document.querySelector("#content");
  const projects = state.activityProjects || [];
  const filters = state.deliveryFilters || { q: "", owner: "", city: "", dateLabel: "" };
  const values = key => [...new Set(projects.map(p => String(p[key] || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const owners = values("ownerName");
  const cities = values("city");
  const dates = values("dateLabel");
  const query = String(filters.q || "").trim().toLowerCase();
  const filteredProjects = projects.filter(p => {
    const haystack = [p.title, p.ownerName, p.city, p.dateLabel].filter(Boolean).join(" ").toLowerCase();
    return (!query || haystack.includes(query))
      && (!filters.owner || p.ownerName === filters.owner)
      && (!filters.city || p.city === filters.city)
      && (!filters.dateLabel || p.dateLabel === filters.dateLabel);
  });
  const totals = filteredProjects.reduce((acc, p) => {
    (p.media || []).forEach(m => { if (m.type === "image") acc.images++; if (m.type === "video") acc.videos++; });
    if (p.sourceCaseId) acc.settled++;
    return acc;
  }, { images: 0, videos: 0, settled: 0 });
  const selectFilter = (label, key, items) => `<label><span>${label}</span><select class="select" data-delivery-filter="${key}"><option value="">全部${label}</option>${items.map(item => `<option value="${esc(item)}" ${filters[key] === item ? "selected" : ""}>${esc(item)}</option>`).join("")}</select></label>`;
  const card = p => {
    const media = p.media || [];
    const images = media.filter(m => m.type === "image").length;
    const videos = media.filter(m => m.type === "video").length;
    const cover = p.cover || (media.find(m => m.type === "image") || {}).url || "";
    const workflowAction = !p.sourceCaseId && media.length
      ? `<button class="btn secondary small" data-delivery-promote="${esc(p.id)}">沉淀案例</button>`
      : p.sourceCaseId
      ? `<button class="btn secondary small" data-delivery-case="${esc(p.sourceCaseId)}">查看案例</button>`
      : `<button class="btn secondary small" type="button" disabled>暂无素材</button>`;
    return `<article class="admin-card delivery-project-card" data-delivery-project="${esc(p.id)}"><div class="admin-card-cover">${cover ? `<img src="${esc(publicUrl(cover))}" alt="${esc(p.title)}" loading="lazy">` : `<div class="admin-card-cover-empty">📸</div>`}<span class="admin-card-status ${p.status === "published" ? "on" : ""}">${p.status === "published" ? "可分享" : "已归档"}</span></div><div class="admin-card-body"><p class="admin-card-title">${esc(p.title)}</p><p class="admin-card-meta"><span>主理人：${esc(p.ownerName || "未标注主理人")}</span><span>${esc([p.city, p.dateLabel].filter(Boolean).join(" · ") || "未填写地点日期")}</span></p><div class="admin-card-structure"><span>${images} 图片</span><span>${videos} 视频</span>${p.sourceCaseId ? `<span class="delivery-card-settled">已沉淀</span>` : ""}</div><div class="audit-counts"><span>查看 ${Number(p.viewCount || 0)}</span><span>下载 ${Number(p.downloadCount || 0)}</span></div><div class="admin-card-actions"><a class="btn small" href="${SILVER_FRONT_BASE}/?view=project-manage&project=${encodeURIComponent(p.id)}" target="_blank" rel="noreferrer">管理相册</a>${workflowAction}<button class="btn ghost small danger" data-delivery-delete="${esc(p.id)}">删除</button></div></div></article>`;
  };
  content.innerHTML = `<div class="topbar"><div><h1>活动交付</h1><p>总部可查看所有主理人的活动相册，并按归属、城市和日期进行管理。</p></div><a class="btn secondary" href="${SILVER_FRONT_BASE}/?view=projects" target="_blank">打开主理人工作台</a></div><div class="content-area">${state.message}<div class="stat-cards delivery-stats"><div class="stat-card"><span>活动相册</span><strong>${filteredProjects.length}</strong><em>全部 ${projects.length} 个</em></div><div class="stat-card"><span>图片素材</span><strong>${totals.images}</strong><em>当前筛选结果</em></div><div class="stat-card"><span>视频素材</span><strong>${totals.videos}</strong><em>当前筛选结果</em></div><div class="stat-card"><span>已沉淀案例</span><strong>${totals.settled}</strong><em>可继续审核发布</em></div></div><div class="panel delivery-filter-panel"><div class="panel-header"><div><h2>筛选活动相册</h2><p>支持按主理人、城市、日期和关键词定位</p></div><button class="btn ghost small" type="button" data-delivery-clear>清除筛选</button></div><div class="delivery-filter-grid"><label><span>关键词</span><input class="input" data-delivery-filter="q" value="${esc(filters.q)}" placeholder="活动名称 / 主理人"></label>${selectFilter("主理人", "owner", owners)}${selectFilter("城市", "city", cities)}${selectFilter("日期", "dateLabel", dates)}</div></div><div class="delivery-results-head"><strong>活动相册列表</strong><span>当前显示 ${filteredProjects.length} 个</span></div>${filteredProjects.length ? `<div class="admin-card-grid">${filteredProjects.map(card).join("")}</div>` : `<div class="panel"><div class="panel-body" style="padding:42px;text-align:center;color:var(--muted)">${projects.length ? "没有符合当前筛选条件的活动相册。" : "还没有活动交付相册。"}</div></div>`}</div>`;
  document.querySelectorAll("[data-delivery-filter]").forEach(el => el.addEventListener("change", e => { state.deliveryFilters[e.target.dataset.deliveryFilter] = e.target.value.trim(); renderDeliveryProjects(); }));
  document.querySelector("[data-delivery-clear]")?.addEventListener("click", () => { state.deliveryFilters = { q: "", owner: "", city: "", dateLabel: "" }; renderDeliveryProjects(); });
  document.querySelectorAll("[data-delivery-promote]").forEach(btn => btn.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "生成中…";
    try { const data = await api(`/api/my/activity-projects/${encodeURIComponent(btn.dataset.deliveryPromote)}/promote-case`, { method: "POST" }); flash(data.message || "已生成案例草稿"); await refreshData(); renderDeliveryProjects(); }
    catch (err) { flash(err.message, "error"); renderDeliveryProjects(); }
  }));
  document.querySelectorAll("[data-delivery-case]").forEach(btn => btn.addEventListener("click", () => {
    state.activeTab = "cases";
    state.caseDetailId = btn.dataset.deliveryCase;
    state.caseEdit = null;
    state.caseMediaTab = "";
    renderShell();
  }));
  document.querySelectorAll("[data-delivery-delete]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("确定删除这个活动交付相册吗？TOS 文件会保留，但分享链接将失效。")) return;
    try { await api(`/api/my/activity-projects/${encodeURIComponent(btn.dataset.deliveryDelete)}`, { method: "DELETE" }); flash("活动交付相册已删除"); await refreshData(); renderDeliveryProjects(); }
    catch (err) { flash(err.message, "error"); renderDeliveryProjects(); }
  }));
}

async function renderCasesAdmin() {
  const content = document.querySelector("#content");
  if (!state.adminCasesLoaded) {
    content.innerHTML = `<div class="center-state">加载中...</div>`;
    try {
      const data = await api("/api/admin/cases");
      state.adminCases = (data.cases || []).map(normalizeCaseAdminState).map(c => ({
        ...c,
        viewCount: auditSummaryCount("case", c.id, "view"),
        downloadCount: auditSummaryCount("case_media", c.id, "download")
      }));
      state.adminCasesLoaded = true;
	    } catch (e) { content.innerHTML = `<div class="center-state">${esc(e.message)}</div>`; return; }
	  }
	  if (state.caseEdit) return renderCaseEditor();
	  if (state.caseDetailId) return renderCaseAdminDetail();

  const groups = [];
  (state.adminCases || []).forEach(c => {
    const key = c.category || "未分类";
    let g = groups.find(x => x.name === key);
    if (!g) { g = { name: key, items: [] }; groups.push(g); }
    g.items.push(c);
  });

  const caseCardHtml = c => {
    const media = c.media || [];
    const n = media.length;
    const thumb = c.cover || (media.find(m => m.type === "image") || {}).url || "";
    const groups = groupedCaseMediaAdmin(c);
    const hasVideo = groups.videos.length > 0 || groups.links.length > 0;
    return `
      <div class="admin-card case-list-card">
        <div class="admin-card-cover">
          ${thumb
            ? `<img src="${esc(publicUrl(thumb))}" alt="${esc(c.title)}" loading="lazy">`
            : `<div class="admin-card-cover-empty">🎬</div>`}
          ${hasVideo ? `<span class="admin-card-flag">▶ 含视频</span>` : ""}
          <span class="admin-card-status ${c.status === "published" ? "on" : ""}">${c.status === "published" ? "已发布" : "草稿"}</span>
        </div>
        <div class="admin-card-body">
          <p class="admin-card-title">${esc(c.title)}</p>
          <p class="admin-card-meta">${esc([c.city, c.dateLabel].filter(Boolean).join(" · ") || "—")} · ${n} 个素材 · 排序 ${Number(c.sortOrder || 9999)}</p>
	          <div class="admin-card-structure">
		            <span>${groups.videos.length} 视频</span>
		            <span>${groups.images.length} 图片</span>
		            <span>${groups.documents.length} 文档</span>
		            <span>${groups.links.length} 链接</span>
	          </div>
	          <div class="audit-counts"><span>查看 ${Number(c.viewCount || 0)}</span><span>下载 ${Number(c.downloadCount || 0)}</span></div>
	          <div class="admin-card-actions">
	            <button class="btn small" data-case-open="${esc(c.id)}">管理内容</button>
	            <button class="btn secondary small" data-case-edit="${esc(c.id)}">编辑上传</button>
	            ${c.sourceProjectId ? `<button class="btn ghost small" data-case-return-delivery="${esc(c.sourceProjectId)}">返回活动交付</button>` : ""}
	            <button class="btn secondary small" data-case-toggle="${esc(c.id)}">${c.status === "published" ? "下架" : "发布"}</button>
	            <button class="btn ghost small" data-case-del="${esc(c.id)}" style="color:#c0392b">删除</button>
	          </div>
        </div>
      </div>`;
  };

  content.innerHTML = `
    <div class="topbar">
      <div><h1>案例管理</h1><p>前台「精彩案例」页的图片与视频,浏览免登录,下载需登录。</p></div>
      <button class="btn" id="caseNewBtn">+ 新建案例</button>
    </div>
    <div class="content-area">
      ${state.message}
      ${groups.length ? groups.map(g => `
        <section class="admin-group">
          <div class="admin-group-head">
            <span class="admin-group-bar"></span>
            <h3>${esc(g.name)}</h3>
            <span class="admin-group-count">${g.items.length} 个案例</span>
          </div>
          <div class="admin-card-grid case-list-grid">${g.items.map(caseCardHtml).join("")}</div>
        </section>`).join("")
      : `<div class="panel"><div class="panel-body" style="padding:40px;text-align:center;color:var(--muted)">还没有案例,点右上角「新建案例」开始添加</div></div>`}
    </div>`;

	  document.querySelector("#caseNewBtn").addEventListener("click", () => {
	    state.caseDetailId = null; state.caseEdit = emptyCase(); renderCasesAdmin();
	  });
		  document.querySelectorAll("[data-case-open]").forEach(b => b.addEventListener("click", () => {
		    state.caseEdit = null; state.caseDetailId = b.dataset.caseOpen; state.caseMediaTab = ""; renderCasesAdmin();
		  }));
		  document.querySelectorAll("[data-case-edit]").forEach(b => b.addEventListener("click", () => {
		    const c = state.adminCases.find(x => x.id === b.dataset.caseEdit);
		    state.caseDetailId = null; state.caseEdit = JSON.parse(JSON.stringify(c)); renderCasesAdmin();
		  }));
	  document.querySelectorAll("[data-case-return-delivery]").forEach(b => b.addEventListener("click", () => openDeliveryProject(b.dataset.caseReturnDelivery)));
  document.querySelectorAll("[data-case-toggle]").forEach(b => b.addEventListener("click", async () => {
    const c = state.adminCases.find(x => x.id === b.dataset.caseToggle);
    try {
      await api(`/api/admin/cases/${encodeURIComponent(c.id)}`, { method:"PATCH", body:{ status: c.status === "published" ? "draft" : "published" } });
      state.adminCasesLoaded = false; flash("✅ 已更新"); renderCasesAdmin();
    } catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
  }));
  document.querySelectorAll("[data-case-del]").forEach(b => b.addEventListener("click", async () => {
    const c = state.adminCases.find(x => x.id === b.dataset.caseDel);
    if (!confirm(`确定删除案例「${c.title}」?素材文件不会被删除,但前台将不再显示。`)) return;
    try {
      await api(`/api/admin/cases/${encodeURIComponent(c.id)}`, { method:"DELETE" });
      state.adminCasesLoaded = false; flash("已删除"); renderCasesAdmin();
    } catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
	  }));
	}

function renderCaseAdminDetail() {
  const content = document.querySelector("#content");
  const c = (state.adminCases || []).find(x => x.id === state.caseDetailId);
  if (!c) {
    state.caseDetailId = null;
    return renderCasesAdmin();
  }
	  const media = c.media || [];
	  const groups = groupedCaseMediaAdmin(c);
	  const tabs = [
	    { key: "videos", title: "视频文件", short: "视频", items: groups.videos, empty: "暂无本地视频文件" },
	    { key: "images", title: "图片素材", short: "图片", items: groups.images, empty: "暂无图片素材" },
	    { key: "documents", title: "文档素材", short: "文档", items: groups.documents, empty: "暂无文档素材" },
	    { key: "links", title: "视频号 / 抖音链接", short: "链接", items: groups.links, empty: "暂无外部平台链接" }
	  ];
	  const fallbackTab = (tabs.find(t => t.items.length) || tabs[0]).key;
	  const activeTab = tabs.some(t => t.key === state.caseMediaTab) ? state.caseMediaTab : fallbackTab;
	  const activeGroup = tabs.find(t => t.key === activeTab) || tabs[0];
	  const mediaCard = m => {
      if (m.type === "link") {
        const label = m.caption || m.title || "外部平台内容，点击跳转查看";
        return `
          <article class="case-admin-link-row">
            <div class="case-admin-link-row-main">
              <div class="case-admin-link-row-head">
                <strong>${esc(casePlatformAdmin(m.url))}</strong>
                <span>#${m.index + 1}</span>
              </div>
              <p>${esc(label)}</p>
              <a class="case-admin-link-url" href="${esc(m.url)}" target="_blank" rel="noreferrer">${esc(m.url)}</a>
            </div>
            <div class="case-admin-link-row-actions">
              <a class="btn secondary small" href="${esc(m.url)}" target="_blank" rel="noreferrer">打开链接</a>
              <button class="btn secondary small" data-case-note="${m.index}">改说明</button>
              <button class="btn ghost small" data-case-up="${m.index}" ${m.index === 0 ? "disabled" : ""}>上移</button>
              <button class="btn ghost small" data-case-down="${m.index}" ${m.index === media.length - 1 ? "disabled" : ""}>下移</button>
              <button class="btn ghost small danger" data-case-remove="${m.index}">删除</button>
            </div>
          </article>`;
      }
	    const preview = m.type === "image"
	      ? `<img src="${esc(publicUrl(m.url))}" alt="" loading="lazy">`
	      : m.type === "video"
	      ? `<button class="case-admin-video-poster" type="button" data-case-video-play="${esc(publicUrl(m.url))}">
	          <video class="case-admin-video-thumb" data-thumb-src="${esc(publicUrl(m.url))}#t=0.5" muted playsinline preload="metadata"></video>
	          <span class="case-admin-play-icon">▶</span>
	          <strong>点击播放</strong>
	        </button>`
	      : m.type === "document"
	      ? `<div class="case-admin-doc-preview">
	          <strong>文档</strong>
	          <span>${esc(m.caption || m.title || fileNameFromUrlAdmin(m.url) || "案例文档素材")}</span>
	        </div>`
	      : "";
    const viewCount = auditSummaryCount("case_media", c.id, "view", m.index);
    const downloadCount = auditSummaryCount("case_media", c.id, "download", m.index);
    return `
      <article class="case-admin-media-card">
        <div class="case-admin-media-preview">${preview}</div>
        <div class="case-admin-media-body">
          <div class="case-admin-media-title">
            <strong>${esc(caseMediaLabelAdmin(m))}</strong>
            <span>#${m.index + 1}</span>
          </div>
          ${m.caption || m.title ? `<p>${esc(m.caption || m.title)}</p>` : `<p class="muted">未填写说明</p>`}
	          <div class="audit-counts"><span>查看 ${viewCount}</span><span>下载 ${downloadCount}</span></div>
	          <div class="case-admin-media-actions">
	            ${m.type === "image" ? `<button class="btn secondary small" data-case-cover="${m.index}">设为封面</button>` : ""}
	            <button class="btn secondary small" data-case-note="${m.index}">改说明</button>
	            ${m.type === "video" ? `<button class="btn secondary small" data-case-move="${m.index}">转移案例</button>` : ""}
	            <button class="btn ghost small" data-case-up="${m.index}" ${m.index === 0 ? "disabled" : ""}>上移</button>
            <button class="btn ghost small" data-case-down="${m.index}" ${m.index === media.length - 1 ? "disabled" : ""}>下移</button>
            <button class="btn ghost small danger" data-case-remove="${m.index}">删除</button>
          </div>
        </div>
      </article>`;
  };

  content.innerHTML = `
    <div class="topbar">
      <div>
        <h1>案例内容管理</h1>
        <p>${esc(c.title)} · ${esc(c.status === "published" ? "已发布" : "草稿")} · 共 ${media.length} 个素材</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn secondary" id="caseDetailBack">返回列表</button>
        <button class="btn secondary" id="caseDetailEdit">编辑上传</button>
        ${c.sourceProjectId ? `<button class="btn ghost" id="caseDetailReturnDelivery" type="button">返回活动交付</button>` : ""}
        <button class="btn" id="caseDetailToggle">${c.status === "published" ? "下架案例" : "发布案例"}</button>
      </div>
    </div>
    <div class="content-area case-admin-detail-page">
      ${state.message}
      <div class="case-admin-detail-controls">
        <section class="case-admin-summary">
          <div>
            <span>分类</span>
            <strong>${esc(c.category || "未分类")}</strong>
          </div>
          <div>
            <span>地区/时间</span>
            <strong>${esc([c.city, c.dateLabel].filter(Boolean).join(" · ") || "未填写")}</strong>
          </div>
          <div>
            <span>排序</span>
            <strong>${Number(c.sortOrder || 9999)}</strong>
          </div>
          <div>
	            <span>素材结构</span>
	            <strong>${groups.videos.length} 视频 / ${groups.images.length} 图片 / ${groups.documents.length} 文档 / ${groups.links.length} 链接</strong>
          </div>
        </section>
	        ${c.description ? `<div class="case-admin-desc">${esc(c.description)}</div>` : ""}
	        <div class="case-admin-category-board" role="tablist" aria-label="案例素材分类">
	          ${tabs.map(t => `
	            <button class="case-admin-category-tab ${t.key === activeTab ? "active" : ""}" type="button" data-case-media-tab="${esc(t.key)}" role="tab" aria-selected="${t.key === activeTab ? "true" : "false"}">
	              <span>${esc(t.title)}</span>
	              <strong>${t.items.length} 个</strong>
	            </button>`).join("")}
	        </div>
      </div>
	      <section class="case-admin-section">
	        <div class="case-admin-section-head">
	          <h2>${esc(activeGroup.title)}</h2>
	          <span>${activeGroup.items.length} 个${esc(activeGroup.short)}</span>
	        </div>
		        ${activeGroup.items.length ? `<div class="${activeGroup.key === "links" ? "case-admin-link-list" : "case-admin-media-grid"}">${activeGroup.items.map(mediaCard).join("")}</div>`
		          : `<div class="case-admin-empty">${esc(activeGroup.empty)}</div>`}
		      </section>
		    </div>`;
		  hydrateCaseAdminVideoThumbs();

		  document.querySelector("#caseDetailBack").addEventListener("click", () => { state.caseDetailId = null; renderCasesAdmin(); });
	  document.querySelector("#caseDetailReturnDelivery")?.addEventListener("click", () => openDeliveryProject(c.sourceProjectId));
	  document.querySelectorAll("[data-case-media-tab]").forEach(b => b.addEventListener("click", () => {
	    state.caseMediaTab = b.dataset.caseMediaTab || "";
	    renderCasesAdmin();
	  }));
	  document.querySelectorAll("[data-case-video-play]").forEach(b => b.addEventListener("click", () => {
	    const url = b.dataset.caseVideoPlay;
	    const wrap = b.closest(".case-admin-media-preview");
	    if (!url || !wrap) return;
	    wrap.innerHTML = `<video src="${esc(url)}#t=0.5" controls preload="metadata" playsinline></video>`;
	  }));
  document.querySelector("#caseDetailEdit").addEventListener("click", () => {
    state.caseDetailId = null;
    state.caseEdit = JSON.parse(JSON.stringify(c));
    renderCasesAdmin();
  });
  document.querySelector("#caseDetailToggle").addEventListener("click", async () => {
    try { await patchCaseAdmin(c, { status: c.status === "published" ? "draft" : "published" }, "状态已更新"); }
    catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
  });
  document.querySelectorAll("[data-case-cover]").forEach(b => b.addEventListener("click", async () => {
    const m = media[Number(b.dataset.caseCover)];
    if (!m) return;
    try { await patchCaseAdmin(c, { cover: m.url }, "封面已更新"); }
    catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
  }));
	  document.querySelectorAll("[data-case-note]").forEach(b => b.addEventListener("click", async () => {
	    const i = Number(b.dataset.caseNote);
	    const m = media[i];
    if (!m) return;
    const next = prompt("修改该素材说明:", m.caption || m.title || "");
    if (next === null) return;
    const nextMedia = media.map((item, idx) => idx === i ? { ...item, caption: next.trim(), title: next.trim() } : item);
	    try { await patchCaseAdmin(c, { media: nextMedia }, "素材说明已更新"); }
	    catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
	  }));
	  document.querySelectorAll("[data-case-move]").forEach(b => b.addEventListener("click", async () => {
	    const i = Number(b.dataset.caseMove);
	    const m = media[i];
	    if (!m || m.type !== "video") return;
	    const targets = (state.adminCases || []).filter(x => x.id !== c.id);
	    if (!targets.length) {
	      alert("当前还没有其他案例可转移。请先新建目标案例，再转移视频。");
	      return;
	    }
	    const options = targets.map((item, idx) => {
	      const g = groupedCaseMediaAdmin(item);
	      const meta = [item.city, item.dateLabel].filter(Boolean).join(" · ");
	      return `${idx + 1}. ${item.title}${meta ? `（${meta}）` : ""} - ${g.videos.length} 视频`;
	    }).join("\n");
	    const raw = prompt(`把第 ${i + 1} 个视频转移到哪个案例？请输入序号：\n\n${options}`);
	    if (raw === null) return;
	    const choice = Number(String(raw).trim());
	    const target = Number.isInteger(choice) ? targets[choice - 1] : null;
	    if (!target) {
	      flash("没有找到对应的目标案例，请输入列表里的序号", "error");
	      renderCasesAdmin();
	      return;
	    }
	    if (!confirm(`确定把第 ${i + 1} 个视频转移到「${target.title}」？`)) return;
	    try {
	      const data = await api(`/api/admin/cases/${encodeURIComponent(c.id)}/media/${i}/move`, {
	        method: "POST",
	        body: { targetCaseId: target.id }
	      });
	      [data.case, data.targetCase].filter(Boolean).forEach(item => {
	        const nextCase = normalizeCaseAdminState(item);
	        const idx = (state.adminCases || []).findIndex(x => x.id === nextCase.id);
	        if (idx >= 0) state.adminCases[idx] = nextCase;
	      });
	      flash(`✅ 视频已转移到「${target.title}」`);
	      renderCasesAdmin();
	    } catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
	  }));
	  document.querySelectorAll("[data-case-up]").forEach(b => b.addEventListener("click", async () => {
	    const i = Number(b.dataset.caseUp);
    if (i <= 0) return;
    const nextMedia = media.slice();
    [nextMedia[i - 1], nextMedia[i]] = [nextMedia[i], nextMedia[i - 1]];
    try { await patchCaseAdmin(c, { media: nextMedia }, "素材顺序已更新"); }
    catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
  }));
  document.querySelectorAll("[data-case-down]").forEach(b => b.addEventListener("click", async () => {
    const i = Number(b.dataset.caseDown);
    if (i >= media.length - 1) return;
    const nextMedia = media.slice();
    [nextMedia[i + 1], nextMedia[i]] = [nextMedia[i], nextMedia[i + 1]];
    try { await patchCaseAdmin(c, { media: nextMedia }, "素材顺序已更新"); }
    catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
  }));
  document.querySelectorAll("[data-case-remove]").forEach(b => b.addEventListener("click", async () => {
    const i = Number(b.dataset.caseRemove);
    const m = media[i];
    if (!m) return;
    if (!confirm(`确定删除第 ${i + 1} 个素材（${caseMediaLabelAdmin(m)}）？删除后前台不再展示，服务器文件仍保留。`)) return;
    const nextMedia = media.filter((_, idx) => idx !== i);
    const body = { media: nextMedia };
    if (c.cover && m.url === c.cover) body.cover = (nextMedia.find(x => x.type === "image") || {}).url || "";
    try { await patchCaseAdmin(c, body, "素材已删除"); }
    catch(e) { flash(e.message, "error"); renderCasesAdmin(); }
  }));
}

	function renderCaseEditor() {
  const content = document.querySelector("#content");
  const c = state.caseEdit;
  const cats = [...new Set([...CASE_DEFAULT_CATS, ...(state.adminCases || []).map(x => x.category).filter(Boolean)])];

	  const mediaRows = (c.media || []).map((m, i) => `
	    <article class="case-edit-media-sort-card">
	      <div class="case-edit-media-sort-preview" title="${esc(caseMediaLabelAdmin(m))}">
	        ${caseMediaSortPreviewAdmin(m, i)}
	        <span class="case-edit-media-sort-index">${String(i + 1).padStart(2, "0")}</span>
	      </div>
	      <div class="case-edit-media-sort-main">
	        <strong>${esc(caseMediaLabelAdmin(m))}</strong>
	        <input class="input case-edit-caption" data-m-caption="${i}" value="${esc(m.caption || m.title || "")}" placeholder="添加说明">
	      </div>
	      <div class="case-edit-media-sort-actions">
	        <button class="btn ghost small" data-m-up="${i}" ${i === 0 ? "disabled" : ""} title="上移" aria-label="上移">↑</button>
	        <button class="btn ghost small" data-m-down="${i}" ${i === (c.media.length - 1) ? "disabled" : ""} title="下移" aria-label="下移">↓</button>
	        <button class="btn ghost small" data-m-del="${i}" style="color:#c0392b" title="删除" aria-label="删除">✕</button>
	      </div>
	    </article>`).join("");

	  content.innerHTML = `
    <div class="topbar">
      <div><h1>${c.id ? "编辑案例" : "新建案例"}</h1><p>填写信息并添加图片/视频素材。</p></div>
      <div style="display:flex;gap:10px">
        <button class="btn secondary" id="caseBackBtn">← 返回列表</button>
        <button class="btn" id="caseSaveBtn">💾 保存案例</button>
      </div>
    </div>
	    <div class="content-area case-editor-area">
	      ${state.message}
	      <div class="case-editor-layout">
	        <div class="panel case-editor-basic-panel"><div class="panel-header"><h2>📋 基本信息</h2></div><div class="panel-body">
          <div class="field"><label>案例标题 *</label><input class="input" id="cTitle" value="${esc(c.title)}" placeholder="例如:旗袍走秀活动完整实录"></div>
          <div class="field"><label>分类</label>
            <input class="input" id="cCategory" list="caseCatList" value="${esc(c.category)}" placeholder="选择或输入新分类">
            <datalist id="caseCatList">${cats.map(x => `<option value="${esc(x)}">`).join("")}</datalist>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="field"><label>城市/地区</label><input class="input" id="cCity" value="${esc(c.city)}" placeholder="例如:北京"></div>
            <div class="field"><label>时间标签</label><input class="input" id="cDate" value="${esc(c.dateLabel)}" placeholder="例如:2026年6月"></div>
          </div>
          <div class="field"><label>案例说明</label><textarea class="textarea" id="cDesc" style="min-height:90px" placeholder="一两句话介绍这个案例的亮点">${esc(c.description)}</textarea></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="field"><label>状态</label>
              <select class="input" id="cStatus">
                <option value="published" ${c.status !== "draft" ? "selected" : ""}>发布</option>
                <option value="draft" ${c.status === "draft" ? "selected" : ""}>草稿</option>
              </select>
            </div>
            <div class="field"><label>排序(小的在前)</label><input class="input" id="cSort" type="number" value="${Number(c.sortOrder || 9999)}"></div>
          </div>
          <div class="field"><label>封面图(不传则用第一张图片)</label>
            <div style="display:flex;align-items:center;gap:10px">
              ${c.cover ? `<img src="${esc(publicUrl(c.cover))}" style="width:96px;height:60px;object-fit:cover;border-radius:6px">` : `<span style="font-size:12px;color:var(--muted)">未设置</span>`}
              <label class="btn secondary small" style="cursor:pointer">上传封面<input type="file" id="cCoverUpload" accept="image/*" style="display:none"></label>
              ${c.cover ? `<button class="btn ghost small" id="cCoverClear">清除</button>` : ""}
            </div>
          </div>
        </div></div>

	        <div class="panel case-edit-media-panel"><div class="panel-header"><h2>🎞 素材(展示顺序即列表顺序)</h2></div><div class="panel-body">
	          <div class="case-edit-media-toolbar">
	            <div class="case-edit-media-upload-actions">
	              <label class="btn secondary small" style="cursor:pointer">+ 添加图片/视频(可多选)<input type="file" id="cMediaUpload" accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" multiple style="display:none"></label>
	              <label class="btn secondary small" style="cursor:pointer">+ 上传文档<input type="file" id="cDocumentUpload" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain" multiple style="display:none"></label>
	              <button class="btn secondary small" id="cLinkAdd">+ 视频号/抖音链接</button>
	            </div>
	            <p id="cUploadTip">可一次勾选多张图片、多个视频或文档,选完自动逐个上传。图片单张≤8MB;视频单个≤300MB;文档单个≤80MB(pdf/word/ppt/excel/csv/txt);视频号/抖音贴链接,前台点击跳转。</p>
	          </div>
	          ${mediaRows ? `<div class="case-edit-media-sort-list">${mediaRows}</div>` : `<p class="case-edit-media-empty">还没有素材,用上方按钮添加</p>`}
	        </div></div>
	      </div>
	    </div>`;

  hydrateCaseAdminVideoThumbs();

  const saveDraftFromForm = () => {
    c.title = document.querySelector("#cTitle").value.trim();
    c.category = document.querySelector("#cCategory").value.trim();
    c.city = document.querySelector("#cCity").value.trim();
    c.dateLabel = document.querySelector("#cDate").value.trim();
	    c.description = document.querySelector("#cDesc").value;
	    c.status = document.querySelector("#cStatus").value;
	    c.sortOrder = Number(document.querySelector("#cSort").value || 9999);
	    document.querySelectorAll("[data-m-caption]").forEach(input => {
	      const i = Number(input.dataset.mCaption);
	      if (c.media && c.media[i]) {
	        c.media[i].caption = input.value.trim();
	        c.media[i].title = input.value.trim();
	      }
	    });
	  };

  document.querySelector("#caseBackBtn").addEventListener("click", () => { state.caseEdit = null; renderCasesAdmin(); });

  document.querySelector("#caseSaveBtn").addEventListener("click", async () => {
    saveDraftFromForm();
    if (!c.title) { flash("请填写案例标题", "error"); renderCaseEditor(); return; }
    const payload = {
      title: c.title, category: c.category, city: c.city, dateLabel: c.dateLabel,
      description: c.description, cover: toRelativeUpload(c.cover),
      media: (c.media || []).map(m => ({ ...m, url: m.type === "link" ? m.url : toRelativeUpload(m.url) })),
      sortOrder: c.sortOrder, status: c.status
	    };
	    try {
	      let savedId = c.id;
	      if (c.id) await api(`/api/admin/cases/${encodeURIComponent(c.id)}`, { method:"PATCH", body: payload });
	      else {
	        const created = await api("/api/admin/cases", { method:"POST", body: payload });
	        savedId = created.case && created.case.id;
	      }
	      state.caseEdit = null; state.caseDetailId = savedId || null; state.adminCasesLoaded = false;
	      flash("✅ 案例已保存"); renderCasesAdmin();
	    } catch(e) { flash(e.message, "error"); renderCaseEditor(); }
	  });

  const readAsDataUrl = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = e => ok(e.target.result); r.onerror = no; r.readAsDataURL(f); });

  document.querySelector("#cCoverUpload").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    saveDraftFromForm();
    try {
      const data = await uploadImageFile(f);
      c.cover = toRelativeUpload(data.url); renderCaseEditor();
    } catch(err) { flash(err.message, "error"); renderCaseEditor(); }
  });
  const coverClear = document.querySelector("#cCoverClear");
  if (coverClear) coverClear.addEventListener("click", () => { saveDraftFromForm(); c.cover = ""; renderCaseEditor(); });

	  const uploadOneImage = async f => {
	    const data = await uploadImageFile(f);
	    c.media.push({ type:"image", url: toRelativeUpload(data.url) });
	  };
		  const uploadOneVideo = async f => {
		    const ext = (f.name.split(".").pop() || "mp4").toLowerCase();
		    const toVideoMedia = ({ url, fingerprint }) => ({ type: "video", url, fingerprint });
		    const hasVideo = candidate => {
		      if (!candidate || candidate.type !== "video") return false;
		      return (c.media || []).some(item =>
		        item.type === "video" &&
		        ((item.url && item.url === candidate.url) || (item.fingerprint && candidate.fingerprint && item.fingerprint === candidate.fingerprint))
		      );
		    };
		    const res = await fetch(apiUrl(`/api/admin/upload-video?ext=${encodeURIComponent(ext)}`), {
	      method: "POST",
	      credentials: SILVER_PUBLIC_MODE ? "include" : "same-origin",
	      body: f
	    });
	    const data = await res.json().catch(() => ({}));
		    if (!res.ok) throw new Error(data.error || `视频上传失败 HTTP ${res.status}`);
		    const mediaItem = toVideoMedia({ url: toRelativeUpload(data.url), fingerprint: data.fingerprint || data.hash });
		    if (hasVideo(mediaItem)) throw new Error("该视频素材已存在，已跳过重复上传");
		    c.media.push(mediaItem);
		  };
	  const uploadOneDocument = async f => {
	    const ext = (f.name.split(".").pop() || "").toLowerCase();
	    const res = await fetch(apiUrl(`/api/admin/upload-document?ext=${encodeURIComponent(ext)}`), {
	      method: "POST",
	      credentials: SILVER_PUBLIC_MODE ? "include" : "same-origin",
	      body: f
	    });
	    const data = await res.json();
	    if (!res.ok) throw new Error(data.error || "文档上传失败");
	    c.media.push({ type:"document", url: data.url, title: f.name, caption: f.name });
	  };

	  document.querySelector("#cMediaUpload").addEventListener("change", async e => {
    const files = [...e.target.files]; if (!files.length) return;
    e.target.value = "";
    saveDraftFromForm();
    const tip = document.querySelector("#cUploadTip");
    let done = 0;
    for (const f of files) {
      const isVideo = /^video\//i.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name);
      if (tip) tip.textContent = `⏳ 正在上传第 ${done + 1}/${files.length} 个:${f.name}(${(f.size / 1024 / 1024).toFixed(1)}MB)${isVideo ? " · 视频较大请勿离开本页" : ""}...`;
      try {
        if (isVideo) await uploadOneVideo(f);
        else await uploadOneImage(f);
        done++;
      } catch(err) { flash(`${f.name}: ${err.message}`, "error"); }
    }
	    flash(`✅ 已上传 ${done}/${files.length} 个素材`);
	    renderCaseEditor();
	  });

	  document.querySelector("#cDocumentUpload").addEventListener("change", async e => {
	    const files = [...e.target.files]; if (!files.length) return;
	    e.target.value = "";
	    saveDraftFromForm();
	    const tip = document.querySelector("#cUploadTip");
	    let done = 0;
	    for (const f of files) {
	      if (tip) tip.textContent = `⏳ 正在上传文档 ${done + 1}/${files.length}:${f.name}(${(f.size / 1024 / 1024).toFixed(1)}MB)...`;
	      try { await uploadOneDocument(f); done++; }
	      catch(err) { flash(`${f.name}: ${err.message}`, "error"); }
	    }
	    flash(`✅ 已上传 ${done}/${files.length} 个文档`);
	    renderCaseEditor();
	  });

	  document.querySelector("#cLinkAdd").addEventListener("click", () => {
    saveDraftFromForm();
    const url = prompt("粘贴视频号/抖音/其他视频链接(https:// 开头):");
    if (!url) return;
    if (!/^https?:\/\//i.test(url.trim())) { flash("链接需以 http(s):// 开头", "error"); renderCaseEditor(); return; }
    c.media.push({ type:"link", url: url.trim() });
    renderCaseEditor();
  });

  document.querySelectorAll("[data-m-del]").forEach(b => b.addEventListener("click", () => {
    saveDraftFromForm(); c.media.splice(Number(b.dataset.mDel), 1); renderCaseEditor();
  }));
  document.querySelectorAll("[data-m-up]").forEach(b => b.addEventListener("click", () => {
    saveDraftFromForm(); const i = Number(b.dataset.mUp);
    [c.media[i-1], c.media[i]] = [c.media[i], c.media[i-1]]; renderCaseEditor();
  }));
  document.querySelectorAll("[data-m-down]").forEach(b => b.addEventListener("click", () => {
    saveDraftFromForm(); const i = Number(b.dataset.mDown);
    [c.media[i+1], c.media[i]] = [c.media[i], c.media[i+1]]; renderCaseEditor();
  }));
}

// ---- 账号管理 ----
function renderUsers() {
  const content = document.querySelector("#content");
  content.innerHTML = `
    <div class="topbar"><div><h1>账号权限</h1><p>管理主理人账号，控制 SOP 下载权限。</p></div></div>
    <div class="content-area">
      ${state.message}
      ${(() => {
        const pend = state.users.filter(u => u.status === "disabled");
        if (!pend.length) return "";
        return `
        <div class="panel" style="margin-bottom:16px;border:1px solid #f0c9a8">
          <div class="panel-header" style="background:#fdf3ea">
            <h2>🔔 待审核账号 <span style="color:#e8462c">(${pend.length})</span></h2>
            <button class="btn small" id="batchApproveUsers" style="background:#2e7d32;color:#fff">✅ 全部通过</button>
          </div>
          <div style="padding:12px;display:flex;flex-direction:column;gap:8px">
            ${pend.map(u => `
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:10px;flex-wrap:wrap">
                <div class="user-avatar">${esc((u.name||u.username).slice(0,1))}</div>
                <div style="flex:1;min-width:140px">
                  <strong>${esc(u.name||u.username)} <span style="font-weight:400;color:var(--muted)">@${esc(u.username)}</span></strong>
                  <div style="font-size:12px;color:var(--muted)">申请角色：${roleLabel(u.role)}</div>
                </div>
                <label class="checkline" style="margin:0;font-size:13px"><input type="checkbox" data-uapprove-dl="${esc(u.id)}" checked> 允许下载SOP</label>
                <button class="btn small" data-approve-user="${esc(u.id)}" style="background:#2e7d32;color:#fff">✅ 通过</button>
                <button class="btn danger small" data-reject-user="${esc(u.id)}">❌ 拒绝</button>
              </div>`).join("")}
          </div>
        </div>`;
      })()}
      <div style="display:grid;grid-template-columns:360px 1fr;gap:16px;align-items:start">

        <!-- 创建账号 -->
        <div class="panel">
          <div class="panel-header"><h2>创建账号</h2></div>
          <div class="panel-body">
            <form id="createUserForm" style="display:flex;flex-direction:column;gap:12px">
              <div class="field"><label>登录账号</label><input class="input" name="username" placeholder="例如：shanghai01"></div>
              <div class="field"><label>姓名/昵称</label><input class="input" name="name" placeholder="例如：上海主理人"></div>
              <div class="row">
                <div class="field">
                  <label>角色</label>
                  <select class="select" name="role">
                    <option value="member">普通学习用户</option>
                    <option value="operator">城市主理人</option>
                    <option value="viewer">只读账号</option>
                    <option value="admin">总部管理员</option>
                  </select>
                </div>
                <div class="field"><label>初始密码</label><input class="input" name="password" placeholder="至少6位"></div>
              </div>
              <label class="checkline">
                <input type="checkbox" name="canDownload" checked>
                <span>允许导出可视化 SOP</span>
              </label>
              <button class="btn" type="submit">创建账号</button>
            </form>
          </div>
        </div>

        <!-- 账号列表:按角色分组的卡片 -->
        <div class="panel">
          <div class="panel-header">
            <h2>账号列表</h2>
            <span style="font-size:12px;color:var(--muted)">${state.users.length} 个账号</span>
          </div>
          <div style="padding:12px">
            ${(() => {
              const order = ["admin", "operator", "member", "viewer"];
              const roles = [...order.filter(r => state.users.some(u => u.role === r)),
                             ...[...new Set(state.users.map(u => u.role))].filter(r => !order.includes(r))];
              return roles.map(role => `
                <section class="admin-group">
                  <div class="admin-group-head">
                    <span class="admin-group-bar"></span>
                    <h3>${esc(roleLabel(role))}</h3>
                    <span class="admin-group-count">${state.users.filter(u => u.role === role).length} 个账号</span>
                  </div>
                  <div class="admin-card-grid users">
                    ${state.users.filter(u => u.role === role).map(u => `
                      <div class="user-block">${userCardHtml(u)}</div>`).join("")}
                  </div>
                </section>`).join("");
            })()}
          </div>
        </div>
      </div>
    </div>`;
  bindUserEvents();
}

function userCardHtml(u) {
  return `
              <div class="user-card" data-uid="${esc(u.id)}">
                <div class="user-avatar">${esc((u.name||u.username).slice(0,1))}</div>
                <div class="user-card-info">
                  <strong>${esc(u.name||u.username)} <span style="font-weight:400;color:var(--muted)">@${esc(u.username)}</span></strong>
                  <span>${roleLabel(u.role)} · ${u.status==="active"?"✅ 启用":"⛔ 停用"} · SOP下载：${u.canDownload?"允许":"禁止"}</span>
                </div>
                <div class="user-card-actions">
                  <button class="btn secondary small" data-toggle-edit="${esc(u.id)}">编辑</button>
                  ${u.id !== state.user.id ? `<button class="btn danger small" data-delete-user="${esc(u.id)}">删除</button>` : ""}
                </div>
              </div>
              <div class="user-detail-panel" id="udp-${esc(u.id)}">
                <div class="row">
                  <div class="field"><label>姓名</label><input class="input" data-u-name value="${esc(u.name)}"></div>
                  <div class="field">
                    <label>角色</label>
                    <select class="select" data-u-role>
                      <option value="admin" ${u.role==="admin"?"selected":""}>总部管理员</option>
                      <option value="operator" ${u.role==="operator"?"selected":""}>城市主理人</option>
                      <option value="viewer" ${u.role==="viewer"?"selected":""}>只读账号</option>
                      <option value="member" ${u.role==="member"?"selected":""}>普通学习用户</option>
                    </select>
                  </div>
                </div>
                <div class="row">
                  <div class="field">
                    <label>账号状态</label>
                    <select class="select" data-u-status>
                      <option value="active" ${u.status==="active"?"selected":""}>✅ 启用</option>
                      <option value="disabled" ${u.status==="disabled"?"selected":""}>⛔ 停用</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>SOP下载权限</label>
                    <select class="select" data-u-dl>
                      <option value="true" ${u.canDownload?"selected":""}>允许下载</option>
                      <option value="false" ${!u.canDownload?"selected":""}>禁止下载</option>
                    </select>
                  </div>
                </div>
                <div class="field"><label>新密码（不改留空）</label><input class="input" data-u-pw placeholder="不修改请留空"></div>
                <div style="display:flex;gap:8px">
                  <button class="btn small" data-save-user="${esc(u.id)}">保存更改</button>
                  <button class="btn secondary small" data-toggle-edit="${esc(u.id)}">取消</button>
                </div>
              </div>`;
}

function bindUserEvents() {
  // ---- 待审核账号：逐个通过 / 拒绝 / 全部通过 ----
  document.querySelectorAll("[data-approve-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.approveUser;
      const u = state.users.find(x => x.id === id) || {};
      const dlBox = document.querySelector(`[data-uapprove-dl="${id}"]`);
      const canDownload = dlBox ? dlBox.checked : true;
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}`, { method:"PUT", body:{
          name: u.name, role: u.role, status:"active", canDownload
        }});
        await refreshData(); flash("✅ 账号已通过并启用"); renderUsers();
      } catch (err) { flash(err.message, "error"); renderUsers(); }
    });
  });
  document.querySelectorAll("[data-reject-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认拒绝并删除该申请账号？")) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(btn.dataset.rejectUser)}`, { method:"DELETE" });
        await refreshData(); flash("已拒绝并删除"); renderUsers();
      } catch (err) { flash(err.message, "error"); renderUsers(); }
    });
  });
  const batchU = document.querySelector("#batchApproveUsers");
  if (batchU) batchU.addEventListener("click", async () => {
    const pend = state.users.filter(u => u.status === "disabled");
    if (!pend.length) return;
    if (!confirm(`确定将这 ${pend.length} 个待审账号全部通过启用？（默认允许下载SOP）`)) return;
    batchU.disabled = true; batchU.textContent = "处理中...";
    let ok = 0, fail = 0;
    for (const u of pend) {
      try { await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method:"PUT", body:{ name:u.name, role:u.role, status:"active", canDownload:true }}); ok++; }
      catch (e) { fail++; }
    }
    await refreshData(); flash(`批量通过完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}`); renderUsers();
  });
  document.querySelector("#createUserForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/admin/users", { method:"POST", body:{
        username:f.get("username"), name:f.get("name"), role:f.get("role"),
        password:f.get("password"), canDownload:f.get("canDownload")==="on"
      }});
      await refreshData(); flash("账号已创建"); renderUsers();
    } catch (err) { flash(err.message, "error"); renderUsers(); }
  });
  document.querySelectorAll("[data-toggle-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = document.querySelector(`#udp-${CSS.escape(btn.dataset.toggleEdit)}`);
      if (panel) panel.classList.toggle("open");
    });
  });
  document.querySelectorAll("[data-save-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.saveUser;
      const panel = document.querySelector(`#udp-${CSS.escape(id)}`);
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}`, { method:"PUT", body:{
          name: panel.querySelector("[data-u-name]").value,
          role: panel.querySelector("[data-u-role]").value,
          status: panel.querySelector("[data-u-status]").value,
          canDownload: panel.querySelector("[data-u-dl]").value === "true",
          password: panel.querySelector("[data-u-pw]").value
        }});
        await refreshData(); flash("账号已更新"); renderUsers();
      } catch (err) { flash(err.message, "error"); renderUsers(); }
    });
  });
  document.querySelectorAll("[data-delete-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除此账号？")) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(btn.dataset.deleteUser)}`, { method:"DELETE" });
        await refreshData(); flash("账号已删除"); renderUsers();
      } catch (err) { flash(err.message, "error"); renderUsers(); }
    });
  });
}

// ---- 导入审核 ----
function renderImport() {
  const content = document.querySelector("#content");
  const sample = [{ title:"同城KTV怀旧金曲局", city:"北京", category:"同城社交与情感系列", price:"69元/人", capacity:"20-40人", duration:"3小时", intro:"通过怀旧金曲把同龄用户聚到一起。" }];
  const pendingList = state.activities.filter(x => x.status !== "published");
  content.innerHTML = `
    <div class="topbar"><div><h1>导入审核</h1><p>批量导入活动方案，审核后发布上架。</p></div></div>
    <div class="content-area">
      ${state.message}
      <div class="panel" style="margin-bottom:16px;border:1px solid #cfe3d4">
        <div class="panel-header" style="background:#f0f8f2"><h2>🤖 智能解析（粘贴文案自动生成活动）</h2></div>
        <div class="panel-body">
          <div class="field">
            <label>把活动文案 / 当日流程直接粘贴进来，AI 自动抽取成结构化活动草稿</label>
            <textarea class="textarea" id="aiParseText" style="min-height:150px" placeholder="例如：8月同城怀旧KTV欢唱局，69元/人含茶水，20-40人，约3小时。14:00签到分组，14:30金曲接龙，15:30个人副歌高光录制，16:20合唱收尾群内发布……"></textarea>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn" id="aiParseBtn">✨ 智能解析并填入表单</button>
            <span style="font-size:13px;color:var(--muted)">解析后自动跳到「活动方案」表单，核对修改后保存、再发布</span>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="panel">
          <div class="panel-header"><h2>📥 批量导入</h2></div>
          <div class="panel-body">
            <form id="importForm" style="display:flex;flex-direction:column;gap:12px">
              <div class="field"><label>导入来源</label><input class="input" name="importSource" value="小程序招募活动导出"></div>
              <div class="field">
                <label>JSON 数据</label>
                <textarea class="textarea mono" name="payload" style="min-height:220px">${esc(JSON.stringify(sample, null, 2))}</textarea>
                <span class="help">支持 JSON 数组或 {"activities":[...]} 格式。可包含：title、city、category、price、capacity、duration、intro、highlights、schedule、plan 等字段。</span>
              </div>
              <button class="btn" type="submit">导入到待审核队列</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>⏳ 审核工作台</h2>
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:12px;color:var(--muted)">${pendingList.length} 条待处理</span>
              ${pendingList.length ? `<button class="btn small" id="batchApproveBtn" style="background:#2e7d32;color:#fff">✅ 全部通过 (${pendingList.length})</button>` : ""}
            </div>
          </div>
          <div style="overflow-x:auto">
            <table class="table">
              <thead><tr><th>活动名称</th><th>地区</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                ${pendingList.length ? pendingList.map(act => `
                  <tr>
                    <td><strong>${esc(act.title)}</strong></td>
                    <td>${esc(act.region||act.city||"—")}</td>
                    <td>${statusTagHtml(act.status)}</td>
                    <td style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" style="background:var(--accent);color:#fff" data-approve="${esc(act.id)}">✅ 通过</button><button class="btn secondary small" style="color:#c0392b;border-color:#c0392b" data-reject="${esc(act.id)}">❌ 驳回</button><button class="btn secondary small" data-edit-import="${esc(act.id)}">编辑</button></td>
                  </tr>`).join("") : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:32px">暂无待审核内容</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  const aiBtn = document.querySelector("#aiParseBtn");
  if (aiBtn) aiBtn.addEventListener("click", async () => {
    const text = (document.querySelector("#aiParseText").value || "").trim();
    if (!text) { flash("请先粘贴活动文案", "error"); return; }
    aiBtn.disabled = true; aiBtn.textContent = "解析中…（约几秒）";
    try {
      const r = await api("/api/admin/parse-activity", { method: "POST", body: { text } });
      flash("✅ 已智能解析，请核对修改后保存");
      applyParsedActivity(r.activity || {});
    } catch (e) {
      flash(e.message || "解析失败", "error");
      aiBtn.disabled = false; aiBtn.textContent = "✨ 智能解析并填入表单";
    }
  });
  document.querySelector("#importForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const raw = JSON.parse(f.get("payload"));
      const activities = Array.isArray(raw) ? raw : raw.activities;
      const data = await api("/api/admin/import-activities", { method:"POST", body:{ importSource:f.get("importSource"), activities }});
      await refreshData(); flash(`导入完成：新增 ${data.created} 个，更新 ${data.updated} 个，跳过 ${data.skipped} 个`); renderImport();
    } catch (err) { flash(err.message, "error"); renderImport(); }
  });
  document.querySelectorAll("[data-approve]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await api("/api/admin/activities/" + btn.dataset.approve, { method:"PATCH", body:{ status:"published" }});
        flash("✅ 活动已发布"); await refreshData(); renderActivities();
      } catch(e) { flash(e.message,"error"); }
    });
  });
  const batchBtn = document.querySelector("#batchApproveBtn");
  if (batchBtn) batchBtn.addEventListener("click", async () => {
    const ids = pendingList.map(x => x.id);
    if (!ids.length) return;
    if (!confirm(`确定将这 ${ids.length} 条全部通过并发布上架？`)) return;
    batchBtn.disabled = true; batchBtn.textContent = "处理中...";
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await api("/api/admin/activities/" + id, { method:"PATCH", body:{ status:"published" }}); ok++; }
      catch(e) { fail++; }
    }
    await refreshData();
    flash(`批量通过完成：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ""}`);
    renderImport();
  });
  document.querySelectorAll("[data-reject]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await api("/api/admin/activities/" + btn.dataset.reject, { method:"PATCH", body:{ status:"rejected" }});
        flash("已驳回"); await refreshData(); renderActivities();
      } catch(e) { flash(e.message,"error"); }
    });
  });
  document.querySelectorAll("[data-edit-import]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.editingId = btn.dataset.editImport; state.activeTab = "activities"; state.formStep = "basic"; clearFlash(); renderShell();
    });
  });
}

// ---- 前台链接 ----
function renderPreview() {
  const content = document.querySelector("#content");
  content.innerHTML = `
    <div class="topbar"><div><h1>前台链接</h1><p>复制链接发给主理人、用户或合作方。</p></div><a class="btn" href="${homeHref()}" target="_blank">🌐 打开前台首页</a></div>
    <div class="content-area">
      ${(() => {
        const groups = [];
        state.activities.forEach(act => {
          const key = act.category || "未分类";
          let g = groups.find(x => x.name === key);
          if (!g) { g = { name: key, items: [] }; groups.push(g); }
          g.items.push(act);
        });
        if (!groups.length) return `<div class="panel"><div class="panel-body" style="padding:40px;text-align:center;color:var(--muted)">暂无活动</div></div>`;
        return groups.map(g => `
          <section class="admin-group">
            <div class="admin-group-head">
              <span class="admin-group-bar"></span>
              <h3>${esc(g.name)}</h3>
              <span class="admin-group-count">${g.items.length} 个活动</span>
            </div>
            <div class="admin-card-grid">
              ${g.items.map(act => `
                <div class="admin-card">
                  <div class="admin-card-body">
                    <p class="admin-card-title">${esc(act.title)}</p>
                    <p class="admin-card-meta">${esc(act.city || "同城")} ${statusTagHtml(act.status)}</p>
                    <div class="admin-card-actions">
                      <a class="btn secondary small" href="${activityHref(act.id)}" target="_blank">打开详情页 ↗</a>
                    </div>
                  </div>
                </div>`).join("")}
            </div>
          </section>`).join("");
      })()}
    </div>`;
}

// ---- 启动 ----
async function boot() {
  try {
    const data = await api("/api/me");
    if (!data.user) { showLogin(); return; }
    state.user = data.user;
    if (state.user.role !== "admin") { window.location.replace(homeHref()); return; }
    await refreshData();
    renderShell();
  } catch { showLogin(); }
}

boot();
