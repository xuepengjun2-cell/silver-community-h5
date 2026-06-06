// =============================================
//  开开华彩 · 活动管理后台
// =============================================

const adminApp = document.querySelector("#adminApp");

const state = {
  user: null,
  activities: [],
  users: [],
  activeTab: "activities",
  editingId: null,
  imageUrls: [],
  scheduleRows: [],
  tags: [],
  formStep: "basic",   // basic | content | sop | media
  message: ""
};

// ---- 工具 ----
function esc(v) {
  return String(v ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function flash(msg, type = "success") {
  state.message = `<div class="message ${type}">${esc(msg)}</div>`;
}
function clearFlash() { state.message = ""; }

function lines(v) { return Array.isArray(v) ? v.join("\n") : String(v || ""); }
function parseLines(v) { return String(v || "").split("\n").map(x => x.trim()).filter(Boolean); }

function roleLabel(r) {
  return { admin:"总部管理员", operator:"城市主理人", viewer:"只读账号", member:"普通学习用户" }[r] || r;
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
          <p>admin / admin123 &nbsp;·&nbsp; city / city123 &nbsp;·&nbsp; member / member123</p>
          ${error ? `<div class="message error" style="margin-bottom:14px">${esc(error)}</div>` : ""}
          <form id="loginForm" style="display:flex;flex-direction:column;gap:14px">
            <div class="field"><label>账号</label><input class="input" id="username" value="admin" autocomplete="username"></div>
            <div class="field"><label>密码</label><input class="input" id="password" type="password" value="admin123" autocomplete="current-password"></div>
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
      await refreshData();
      renderShell();
    } catch (err) { showLogin(err.message); }
  });
}

// ---- 数据刷新 ----
async function refreshData() {
  const d = await api("/api/admin/activities");
  state.activities = d.activities || [];
  if (state.user?.role === "admin") {
    const ud = await api("/api/admin/users");
    state.users = ud.users || [];
  }
}

// ---- 主框架 ----
function renderShell() {
  const u = state.user;
  const isAdmin = u.role === "admin";
  const notViewer = u.role !== "viewer";

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
            <span class="nav-icon">📥</span>导入审核
          </button>` : ""}
          <button data-tab="preview" class="${state.activeTab==="preview"?"active":""}">
            <span class="nav-icon">🔗</span>前台链接
          </button>
          ${isAdmin ? `<span class="nav-section-label">系统</span>
          <button data-tab="users" class="${state.activeTab==="users"?"active":""}">
            <span class="nav-icon">👥</span>账号权限
          </button>` : ""}
        </nav>
        <div class="side-foot">
          <a class="btn secondary small" href="/" target="_blank" style="margin-bottom:8px;display:flex">🌐 打开前台</a>
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
    state.user = null; showLogin();
  });
  renderContent();
}

function renderContent() {
  if (state.activeTab === "users") renderUsers();
  else if (state.activeTab === "import") renderImport();
  else if (state.activeTab === "preview") renderPreview();
  else renderActivities();
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

function renderActivities() {
  const content = document.querySelector("#content");
  const a = currentActivity();
  state.imageUrls = Array.isArray(a.images) ? [...a.images] : [];
  state.scheduleRows = Array.isArray(a.schedule) ? a.schedule.map(x => ({...x})) : [];
  state.tags = Array.isArray(a.tags) ? [...a.tags] : [];

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
          <div style="padding:12px;max-height:calc(100vh - 260px);overflow-y:auto">
            <div class="activity-list">
              ${state.activities.map(act => `
                <div class="activity-row ${act.id === state.editingId ? "editing" : ""}" data-edit="${esc(act.id)}">
                  <img src="${esc(act.cover || "/assets/people/cn-social-cafe.jpg")}" alt="">
                  <div class="activity-row-info">
                    <h3>${esc(act.title)}</h3>
                    <div class="activity-row-meta">
                      <span>${esc(act.city || "同城")}</span>
                      <span>·</span>
                      ${statusTagHtml(act.status)}
                    </div>
                    <div style="font-size:11px;color:var(--hint);margin-top:2px">${esc(act.price || "价格待定")}</div>
                  </div>
                  <div class="activity-row-actions">
                    <a class="btn secondary small" href="/activity/${encodeURIComponent(act.id)}" target="_blank">预览</a>
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
              ${state.editingId ? `<a class="btn secondary small" href="/activity/${encodeURIComponent(state.editingId)}" target="_blank">预览页面</a>` : ""}
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
              <div class="form-section-title">活动流程</div>
              <div class="field">
                <label>活动时间线</label>
                <div class="schedule-editor" id="scheduleEditor">
                  ${renderScheduleRows(canEdit)}
                </div>
                ${canEdit ? `<button class="add-row-btn" type="button" id="addScheduleRow">＋ 添加流程节点</button>` : ""}
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
              <div class="form-section-title">执行策略</div>
              <div class="row">
                <div class="field">
                  <label>🎯 运营目标</label>
                  <textarea class="textarea short" name="target" placeholder="这场活动的核心目的是什么？筛选什么样的用户？" ${dis}>${esc(a.plan?.target)}</textarea>
                </div>
                <div class="field">
                  <label>📦 核心物料清单</label>
                  <textarea class="textarea short" name="materials" placeholder="例如：大字歌单、麦克风、补光灯、手机稳定器" ${dis}>${esc(a.plan?.materials)}</textarea>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <label>👥 人力配置</label>
                  <textarea class="textarea short" name="staffing" placeholder="例如：1名主理人、1名控场主持、1名摄影人员" ${dis}>${esc(a.plan?.staffing)}</textarea>
                </div>
                <div class="field">
                  <label>🔄 转化承接</label>
                  <textarea class="textarea short" name="conversion" placeholder="活动后如何把参与者转化为下次活动/课程用户？" ${dis}>${esc(a.plan?.conversion)}</textarea>
                </div>
              </div>
              <div class="field">
                <label>⚠️ 风险控制</label>
                <textarea class="textarea short" name="risk" placeholder="安全提示、场地注意事项、应急预案等" ${dis}>${esc(a.plan?.risk)}</textarea>
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
                <span>允许有权限的用户下载 SOP 文件</span>
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
      <img src="${esc(url)}" alt="图${i+1}">
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
        const dataUrl = await readFile(file);
        const data = await api("/api/admin/upload-image", { method:"POST", body:{ dataUrl, fileName:file.name } });
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

// ---- 账号管理 ----
function renderUsers() {
  const content = document.querySelector("#content");
  content.innerHTML = `
    <div class="topbar"><div><h1>账号权限</h1><p>管理主理人账号，控制 SOP 下载权限。</p></div></div>
    <div class="content-area">
      ${state.message}
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
                <span>允许下载 SOP 文件</span>
              </label>
              <button class="btn" type="submit">创建账号</button>
            </form>
          </div>
        </div>

        <!-- 账号列表 -->
        <div class="panel">
          <div class="panel-header">
            <h2>账号列表</h2>
            <span style="font-size:12px;color:var(--muted)">${state.users.length} 个账号</span>
          </div>
          <div style="padding:12px;display:flex;flex-direction:column;gap:6px">
            ${state.users.map(u => `
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
              </div>`).join("")}
          </div>
        </div>
      </div>
    </div>`;
  bindUserEvents();
}

function bindUserEvents() {
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
            <span style="font-size:12px;color:var(--muted)">${pendingList.length} 条待处理</span>
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
                    <td><button class="btn secondary small" data-edit-import="${esc(act.id)}">编辑审核</button></td>
                  </tr>`).join("") : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:32px">暂无待审核内容</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

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
    <div class="topbar"><div><h1>前台链接</h1><p>复制链接发给主理人、用户或合作方。</p></div><a class="btn" href="/" target="_blank">🌐 打开前台首页</a></div>
    <div class="content-area">
      <div class="panel">
        <div style="overflow-x:auto">
          <table class="table">
            <thead><tr><th>活动名称</th><th>城市</th><th>状态</th><th>前台链接</th></tr></thead>
            <tbody>
              ${state.activities.map(act => `
                <tr>
                  <td><strong>${esc(act.title)}</strong></td>
                  <td>${esc(act.city||"同城")}</td>
                  <td>${statusTagHtml(act.status)}</td>
                  <td><a class="btn secondary small" href="/activity/${encodeURIComponent(act.id)}" target="_blank">打开详情页 ↗</a></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// ---- 启动 ----
async function boot() {
  try {
    const data = await api("/api/me");
    if (!data.user) { showLogin(); return; }
    state.user = data.user;
    await refreshData();
    renderShell();
  } catch { showLogin(); }
}

boot();
