// =============================================
//  开开华彩 · 活动 SOP 平台 · 前台逻辑
// =============================================

const app = document.querySelector("#app");

const state = {
  siteConfig: {},
  banners: [],
  activities: [],
  cities: [],
  categories: [],
  user: null,
  loginOpen: false,
  authMessage: "",
  currentActivity: null,
  activeTab: "intro",
  favorites: new Set(JSON.parse(localStorage.getItem("kk_favs") || "[]")),
  filters: { q: "", city: "", category: "" }
};

// ---- 工具函数 ----
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

function opts(items, sel, label) {
  return `<option value="">${label}</option>${items.map(i =>
    `<option value="${esc(i)}" ${i === sel ? "selected" : ""}>${esc(i)}</option>`).join("")}`;
}

function roleLabel(r) {
  return { admin:"总部管理员", operator:"城市主理人", viewer:"只读账号", member:"学习用户" }[r] || r;
}

function canDownload() {
  return Boolean(state.user && (state.user.canDownload || ["admin","operator"].includes(state.user.role)));
}

function saveFavs() {
  localStorage.setItem("kk_favs", JSON.stringify([...state.favorites]));
}

function rerenderCurrent() {
  if (state.currentActivity) renderDetail(state.currentActivity);
  else renderList();
}

// ---- 顶部用户栏 ----
function authBar() {
  if (!state.user) return `<button class="btn secondary small" type="button" data-open-login>登录学习</button>`;
  return `
    <div class="user-chip">
      <span>${esc(state.user.name || state.user.username)}</span>
      <em>${esc(roleLabel(state.user.role))}</em>
    </div>
    <button class="text-btn" type="button" id="logoutBtn">退出</button>`;
}

// ---- 登录弹窗 ----
function loginModal() {
  if (!state.loginOpen) return "";
  return `
    <div class="modal-mask">
      <form class="login-modal" id="loginForm">
        <button class="modal-close" type="button" data-close-login>×</button>
        <h2>登录学习平台</h2>
        <p>登录后可查看完整活动 SOP，权限开通后可下载文件。</p>
        ${state.authMessage ? `<div class="message error">${esc(state.authMessage)}</div>` : ""}
        <div class="field">
          <label>账号</label>
          <input class="input" name="username" autocomplete="username" placeholder="请输入账号">
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" name="password" type="password" autocomplete="current-password" placeholder="请输入密码">
        </div>
        <button class="btn" type="submit">进入学习</button>
        
      </form>
    </div>`;
}

function bindAuthEvents() {
  document.querySelectorAll("[data-open-login]").forEach(btn =>
    btn.addEventListener("click", () => { state.loginOpen = true; state.authMessage = ""; rerenderCurrent(); }));
  document.querySelectorAll("[data-close-login]").forEach(btn =>
    btn.addEventListener("click", () => { state.loginOpen = false; rerenderCurrent(); }));
  const logoutBtn = document.querySelector("#logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    await api("/api/logout", { method:"POST", body:{} });
    state.user = null; window.location.reload();
  });
  const loginForm = document.querySelector("#loginForm");
  if (loginForm) loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const data = await api("/api/login", { method:"POST", body:{ username:f.get("username"), password:f.get("password") } });
      state.user = data.user; state.loginOpen = false; state.authMessage = ""; rerenderCurrent();
    } catch (err) { state.authMessage = err.message; rerenderCurrent(); }
  });
}

// ---- 活动列表 ----
function activityCard(a) {
  const isFav = state.favorites.has(a.id);
  const tags = (a.tags || []).slice(0, 3).map(t => `<span class="tag-pill">${esc(t)}</span>`).join("");
  return `
    <article class="activity-card" data-id="${esc(a.id)}">
      <div class="card-img">
        <img src="${esc(a.cover || "/assets/people/cn-social-cafe.jpg")}" alt="${esc(a.title)}" loading="lazy">
        <div class="card-img-badges">
          <span class="badge badge-city">${esc(a.city || "同城")}</span>
          <span class="badge badge-cat">${esc(a.category || "活动")}</span>
        </div>
        <button class="card-fav ${isFav ? "active" : ""}" data-fav="${esc(a.id)}" title="收藏">
          ${isFav ? "♥" : "♡"}
        </button>
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(a.title)}</h3>
        <p class="card-intro">${esc(a.intro)}</p>
        <div class="card-tags">${tags}</div>
        <div class="card-footer">
          <div>
            <div class="card-price">${esc(a.price || "咨询主理人")}</div>
            <div class="card-meta">${esc(a.capacity || "")}${a.duration ? " · "+esc(a.duration) : ""}</div>
          </div>
          <a class="card-cta" href="/activity/${encodeURIComponent(a.id)}">查看方案 →</a>
        </div>
      </div>
    </article>`;
}

function groupActivities(list) {
  const map = new Map();
  list.forEach(a => {
    const cat = a.category || "其他活动";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(a);
  });
  return [...map.entries()].map(([cat, acts], i) => ({ cat, acts, anchor: `cat-${i+1}` }));
}

function quickCard(g, i) {
  return `
    <a class="quick-card" href="#${esc(g.anchor)}">
      <span class="qc-num">大类 ${i+1}</span>
      <strong>${esc(g.cat)}</strong>
      <em>共 ${g.acts.length} 个方案</em>
    </a>`;
}

function catSection(g, i) {
  return `
    <section class="category-section" id="${esc(g.anchor)}">
      <div class="category-header">
        <span class="cat-num">大类 ${i+1}</span>
        <h3>${esc(g.cat)}</h3>
        <p>${g.acts.length} 个标准活动方案</p>
      </div>
      <div class="activity-grid">
        ${g.acts.map(activityCard).join("")}
      </div>
    </section>`;
}

function renderList() {
  state.currentActivity = null;
  const groups = groupActivities(state.activities);
  const quickGroups = groups.slice(0, 5);
  const first = state.activities[0];

  app.className = "app-shell";
  app.innerHTML = `
    <header class="site-header">
      <a class="brand-mark" href="/">
        <div class="brand-icon"></div>
        <span>开开华彩</span>
      </a>
      <nav>
        <a href="#quick-entry">分类入口</a>
        <a href="#activity-list">活动库</a>
        <a href="/admin">管理后台</a>
        <div class="auth-actions">${authBar()}</div>
      </nav>
    </header>

    <!-- Hero -->
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">
          <span class="eyebrow-dot"></span>
          全国同城主理人 · 活动 SOP 学习平台
        </div>
        <h1>让每座城市的<br><em>银发社群</em>都能<br>办出好活动</h1>
        <p>${state.siteConfig.heroDesc || '精选 '+state.activities.length+' 套活动方案，包含完整执行流程、物料清单、价格参考、风险控制，主理人学习即可落地执行。'}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <a class="btn" href="#activity-list">浏览活动库</a>
          ${state.user
            ? `<a class="btn secondary" href="/admin">进入后台</a>`
            : `<button class="btn secondary" type="button" data-open-login>登录学习</button>`}
        </div>
        <div class="hero-stats">
          <div class="hero-stat"><strong>${state.activities.length}+</strong><span>活动方案</span></div>
          <div class="hero-stat"><strong>${groups.length}</strong><span>活动大类</span></div>
          <div class="hero-stat"><strong>${state.cities.length || "全国"}+</strong><span>覆盖城市</span></div>
        </div>
      </div>
        <div class="hero-visual">
          ${(state.banners||[]).length >= 1 ? `
            <div style="position:relative;width:100%;height:100%;border-radius:16px;overflow:hidden">
              ${(state.banners||[]).map((url,i) => `<img class="banner-slide" src="${esc(url)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 0.6s">`).join("")}
              ${(state.banners||[]).length >= 2 ? `<div style="position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:2">${(state.banners||[]).map((_,i)=>`<span class="banner-dot" style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.5);cursor:pointer;transition:background 0.3s;display:block"></span>`).join("")}</div>` : ""}
            </div>
          ` : `
            <img class="hero-img-main" src="${esc(first?.cover || "/assets/people/cn-social-cafe.jpg")}" alt="活动展示">
            ${state.activities[3] ? `<img class="hero-img-float" src="${esc(state.activities[3].cover || "/assets/people/cn-social-cafe.jpg")}" alt="活动展示">` : ""}
            <div class="hero-badge">
              <strong>${esc(first?.title || "精选活动方案")}</strong>
              <span>${esc(first?.city || "同城")} · ${esc(first?.category || "银发社群")}</span>
            </div>
          `}
        </div>
    </section>

    <!-- 快速分类入口 -->
    <div id="quick-entry" class="quick-entry">
      <div class="section-label">
        <div class="label-bar"></div>
        <div>
          <h2>活动大类</h2>
          <p>按主题快速定位适合的活动方向</p>
        </div>
      </div>
      <div class="quick-grid">${quickGroups.map(quickCard).join("")}</div>
    </div>

    <!-- 活动列表 -->
    <section id="activity-list">
      <div class="section-label" style="margin-bottom:16px">
        <div class="label-bar"></div>
        <div>
          <h2>活动方案库</h2>
          <p>按城市、类型和关键词筛选，找到适合本地执行的方案</p>
        </div>
      </div>
      <div class="filters-bar">
        <input class="input" id="q" placeholder="搜索活动名称、标签、城市…" value="${esc(state.filters.q)}">
        <select class="select" id="city">${opts(state.cities, state.filters.city, "全部城市")}</select>
        <select class="select" id="category">${opts(state.categories, state.filters.category, "全部大类")}</select>
      </div>
      <div class="category-groups">
        ${groups.length ? groups.map(catSection).join("") : `<div class="empty">暂无符合条件的活动方案</div>`}
      </div>
    </section>

    ${loginModal()}`;

  // 筛选事件
  document.querySelector("#q").addEventListener("input", e => {
    state.filters.q = e.target.value.trim();
    clearTimeout(window.__ft);
    window.__ft = setTimeout(loadList, 260);
  });
  document.querySelector("#city").addEventListener("change", e => { state.filters.city = e.target.value; loadList(); });
  document.querySelector("#category").addEventListener("change", e => { state.filters.category = e.target.value; loadList(); });

  // 收藏事件
  document.querySelectorAll("[data-fav]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.fav;
      if (state.favorites.has(id)) state.favorites.delete(id);
      else state.favorites.add(id);
      saveFavs();
      btn.textContent = state.favorites.has(id) ? "♥" : "♡";
      btn.classList.toggle("active", state.favorites.has(id));
    });
  });

  bindAuthEvents();
}

// ---- 详情页 ----
function pillow(text, cls = "badge-city") {
  if (!text) return "";
  return `<span class="badge ${esc(cls)}">${esc(text)}</span>`;
}

function panelTitle(text) {
  return `<div class="panel-title"><span class="title-bar"></span>${esc(text)}</div>`;
}

// Tab 1: 活动介绍
function tabIntro(a) {
  const highlights = (a.highlights || []).map(x => `<li>${esc(x)}</li>`).join("") || "<li>主理人可在后台补充活动亮点。</li>";
  const timeline = (a.schedule || []).map(x => `
    <div class="timeline-row">
      <time>${esc(x.time)}</time>
      <div class="tl-item">${esc(x.item)}</div>
    </div>`).join("") || `<div class="timeline-row"><time>待定</time><div class="tl-item">主理人可在后台补充流程。</div></div>`;

  return `
    <div class="intro-grid">
      <div class="panel">
        ${panelTitle("活动亮点")}
        <ul class="highlight-list">${highlights}</ul>
      </div>
      <div class="panel">
        ${panelTitle("活动流程")}
        <div class="timeline">${timeline}</div>
      </div>
    </div>`;
}

// Tab 2: 执行 SOP
function tabSop(a) {
  const plan = a.plan || {};
  const planCard = (title, icon, content) => content ? `
    <div class="sop-card">
      <div class="sop-card-title">${icon} ${esc(title)}</div>
      <p>${esc(content)}</p>
    </div>` : "";

  const downloadHtml = !state.user
    ? `<div class="download-info"><h4>下载完整 SOP 文件</h4><p>登录后可查看 SOP 学习内容，管理员开通权限后可下载。</p></div>
       <button class="btn" type="button" data-open-login>登录学习</button>`
    : a.downloadEnabled === false
    ? `<div class="download-info"><h4>SOP 文件</h4><p>该活动暂未开放 SOP 下载，请联系总部开通。</p></div>
       <button class="btn secondary" disabled>暂未开放下载</button>`
    : canDownload()
    ? `<div class="download-info"><h4>下载完整 SOP 文件</h4><p>包含执行核查清单、物料模板、话术参考，可转发给新手主理人使用。</p></div>
       <div style="display:flex;gap:10px;flex-wrap:wrap;">
         <button class="btn" type="button" id="downloadSopBtn">⬇ 下载 SOP</button>
         <span id="downloadTip" style="font-size:13px;color:var(--muted);align-self:center;"></span>
       </div>`
    : `<div class="download-info"><h4>SOP 文件</h4><p>当前账号暂未开通下载权限，请联系管理员申请。</p></div>
       <button class="btn secondary" disabled>待开通权限</button>`;

  return `
    <div class="sop-stages">
      <div class="sop-stage">
        <div class="sop-stage-head pre">📋 活动前</div>
        <div class="sop-stage-body">确认报名人数、场地动线、物料备齐、老师/摄影落实、用户提醒和应急预案。</div>
      </div>
      <div class="sop-stage">
        <div class="sop-stage-head mid">🎯 活动中</div>
        <div class="sop-stage-body">先签到分组，再破冰控场，确保每个用户都有被照顾和被记录的体验点。</div>
      </div>
      <div class="sop-stage">
        <div class="sop-stage-head post">✅ 活动后</div>
        <div class="sop-stage-body">24小时内发布作品，复盘用户标签，私聊反馈，并承接下次活动或课程。</div>
      </div>
    </div>
    <div class="sop-grid">
      ${planCard("运营目标", "🎯", plan.target)}
      ${planCard("核心物料", "📦", plan.materials)}
      ${planCard("人力配置", "👥", plan.staffing)}
      ${planCard("转化承接", "🔄", plan.conversion)}
      ${planCard("风险控制", "⚠️", plan.risk)}
    </div>
    <div class="download-section">${downloadHtml}</div>`;
}

// Tab 3: 参考素材
function tabMedia(a) {
  const images = a.images?.length ? a.images : [a.cover].filter(Boolean);
  const galleryImgs = images.map((src, i) =>
    `<img src="${esc(src)}" alt="${esc(a.title)}" class="${i === 0 ? "img-main" : ""}" loading="lazy">`).join("");

  const videoLinks = (Array.isArray(a.videos) ? a.videos.filter(Boolean) : []);
  const refLinks = (Array.isArray(a.references) ? a.references.filter(Boolean) : []);

  const linkItem = (url, index, label) =>
    `<a class="resource-link" href="${esc(url)}" target="_blank" rel="noreferrer">
      <span class="link-icon">🔗</span>${esc(label)} ${index+1}
    </a>`;

  return `
    <div class="gallery-grid">${galleryImgs || `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--muted)">暂无活动图片</div>`}</div>
    <div class="resource-row">
      <div class="resource-box">
        <h4>📹 视频参考</h4>
        ${videoLinks.length
          ? videoLinks.map((u,i) => linkItem(u, i, "视频参考")).join("")
          : `<p style="font-size:13px;color:var(--hint);">暂无视频参考，主理人可在后台添加。</p>`}
      </div>
      <div class="resource-box">
        <h4>📄 方案参考</h4>
        ${refLinks.length
          ? refLinks.map((u,i) => linkItem(u, i, "方案参考")).join("")
          : `<p style="font-size:13px;color:var(--hint);">暂无方案参考，主理人可在后台添加。</p>`}
      </div>
    </div>`;
}

// Tab 4: 交流区
function tabCommunity(a) {
  const mockPosts = [];

  const composeBlock = state.user ? `
    <div class="post-compose">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div class="author-avatar">${esc((state.user.name || state.user.username).slice(0,1))}</div>
        <div style="flex:1">
          <textarea id="postTextarea" placeholder="分享你的执行经验、问题或优化方案…&#10;优质内容可申请提交为正式活动方案"></textarea>
          <div class="post-compose-actions">
            <span class="post-hint">📸 上传图片可增加可信度 · 优质经验帖将被推荐置顶</span>
            <div style="display:flex;gap:8px;">
              <button class="btn secondary small" id="uploadImgBtn">📎 上传图片</button>
              <button class="btn small" id="submitPostBtn">发布经验</button>
            </div>
          </div>
        </div>
      </div>
    </div>` : `
    <div class="post-compose" style="text-align:center;padding:28px;">
      <p style="color:var(--muted);margin:0 0 14px;font-size:14px;">登录后参与交流，分享活动执行经验</p>
      <button class="btn small" type="button" data-open-login>登录发言</button>
    </div>`;

  const postCards = mockPosts.map(p => `
    <div class="post-card ${p.featured ? "featured" : ""}">
      <div class="post-header">
        <div class="post-author">
          <div class="author-avatar">${esc(p.author.slice(3,4) || p.author.slice(0,1))}</div>
          <div>
            <div class="author-name">${esc(p.author)}</div>
            <div class="author-role">${esc(p.city)} · ${esc(p.role)}</div>
          </div>
        </div>
        <div class="post-meta-right">
          <span class="post-time">${esc(p.time)}</span>
          ${p.featured ? `<span class="post-featured-badge">⭐ 精选</span>` : ""}
        </div>
      </div>
      <div class="post-content">${esc(p.content).replace(/\n/g,"<br>")}</div>
      <div class="post-actions">
        <button class="post-action-btn" data-like="${p.id}">
          ♡ <span class="like-count">${p.likes}</span>
        </button>
        <button class="post-action-btn">💬 ${p.comments} 条回复</button>
        <button class="post-action-btn" style="margin-left:auto">📤 分享</button>
        ${state.user && ["admin","operator"].includes(state.user.role) ? `<button class="post-action-btn" style="color:var(--accent)">⭐ 设为精选</button>` : ""}
      </div>
    </div>`).join("");

  return `
    <div class="community-section">
      <div class="community-intro">
        <div>
          <h4>主理人交流区</h4>
          <p>分享执行心得、踩坑记录、本地化改良方案。</p>
        </div>
        <button style="display:none" class="btn small ghost" style="white-space:nowrap" ${state.user ? "" : "data-open-login"}>
          📝 提交我的方案
        </button>
      </div>
      ${composeBlock}
      <div id="postsList" style="margin-top:18px"></div>
      <div class="post-list">${postCards}</div>
    </div>`;
}

function renderDetail(a) {
  state.currentActivity = a;
  const isFav = state.favorites.has(a.id);
  const tab = state.activeTab;

  app.className = "app-shell detail-shell";
  app.innerHTML = `
    <nav class="top-nav">
      <a class="btn secondary small" href="/">← 返回活动库</a>
      <div class="auth-actions">${authBar()}</div>
    </nav>

    <!-- 大图 Hero -->
    <div class="detail-hero" style="margin-top:20px">
      <img class="detail-cover-full"
           src="${esc(a.cover || (a.images && a.images[0]) || "/assets/people/cn-social-cafe.jpg")}"
           alt="${esc(a.title)}">
      <div class="detail-hero-overlay">
        <div class="detail-hero-content">
          <div class="meta-pills">
            ${pillow(a.city || "同城", "badge-city")}
            ${pillow(a.category || "活动", "badge-cat")}
            ${pillow(a.activityType, "badge-city")}
          </div>
          <h1>${esc(a.title)}</h1>
          <p class="intro">${esc(a.intro)}</p>
        </div>
      </div>
    </div>

    <!-- 关键数字 -->
    <div class="facts-bar">
      <div class="fact-item">
        <span>参考价格</span>
        <strong class="price-val">${esc(a.price || "咨询主理人")}</strong>
      </div>
      <div class="fact-item">
        <span>适合人数</span>
        <strong>${esc(a.capacity || "待确认")}</strong>
      </div>
      <div class="fact-item">
        <span>活动时长</span>
        <strong>${esc(a.duration || "待确认")}</strong>
      </div>
      <div class="fact-item">
        <span>推荐地点</span>
        <strong>${esc(a.location || "同城合适场地")}</strong>
      </div>
    </div>

    <!-- Tab 导航 -->
    <div class="detail-tabs">
      <button class="detail-tab ${tab === "intro" ? "active" : ""}" data-tab="intro">
        <span class="tab-icon">📋</span>活动介绍
      </button>
      <button class="detail-tab ${tab === "sop" ? "active" : ""}" data-tab="sop">
        <span class="tab-icon">📌</span>执行 SOP
      </button>
      <button class="detail-tab ${tab === "media" ? "active" : ""}" data-tab="media">
        <span class="tab-icon">🖼</span>参考素材
      </button>
      <button class="detail-tab ${tab === "community" ? "active" : ""}" data-tab="community">
        <span class="tab-icon">💬</span>交流区
      </button>
    </div>

    <!-- Tab 内容 -->
    <div id="tab-intro" class="tab-panel ${tab === "intro" ? "active" : ""}">${tabIntro(a)}</div>
    <div id="tab-sop" class="tab-panel ${tab === "sop" ? "active" : ""}">${tabSop(a)}</div>
    <div id="tab-media" class="tab-panel ${tab === "media" ? "active" : ""}">${tabMedia(a)}</div>
    <div id="tab-community" class="tab-panel ${tab === "community" ? "active" : ""}">${tabCommunity(a)}</div>

    <!-- 底部固定栏 -->
    <div class="sticky-cta">
      <div class="sticky-cta-info">
        <div class="sticky-cta-title">${esc(a.title)}</div>
        <div class="sticky-cta-sub">${esc(a.price || "")}${a.city ? " · "+esc(a.city) : ""}</div>
      </div>
      <div class="sticky-cta-btns">
        <button class="btn light" id="favDetailBtn">${isFav ? "♥ 已收藏" : "♡ 收藏"}</button>
        <button class="btn light" id="copyBtn">复制链接</button>
        ${canDownload() && a.downloadEnabled !== false
          ? `<button class="btn" id="downloadSopBtn">⬇ 下载 SOP</button>`
          : `<button class="btn" type="button" data-open-login>登录学习</button>`}
      </div>
    </div>

    ${loginModal()}`;

  // Tab 切换
  document.querySelectorAll(".detail-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll(".detail-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === state.activeTab));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${state.activeTab}`));
    });
  });

  // 收藏按钮（底部栏）
  const favBtn = document.querySelector("#favDetailBtn");
  if (favBtn) favBtn.addEventListener("click", () => {
    if (state.favorites.has(a.id)) state.favorites.delete(a.id);
    else state.favorites.add(a.id);
    saveFavs();
    favBtn.textContent = state.favorites.has(a.id) ? "♥ 已收藏" : "♡ 收藏";
  });

  // 复制链接
  document.querySelectorAll("#copyBtn").forEach(copyBtn => {
  copyBtn.addEventListener("click", () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = location.href;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      copyBtn.textContent = "✓ 已复制";
    } catch (e) { copyBtn.textContent = "复制失败"; }
    setTimeout(() => copyBtn.textContent = "复制链接", 1500);
  });
  });

  // 下载 SOP
  document.querySelectorAll("#downloadSopBtn").forEach(dlBtn => {
  dlBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/public/activities/${encodeURIComponent(a.id)}/download`, { credentials:"same-origin" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "下载失败"); }
      const e2 = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const rv = v => {
        if (v == null || v === "") return "";
        if (Array.isArray(v)) return "<ul>" + v.map(x => "<li>" + (typeof x === "object" ? rv(x) : e2(x)) + "</li>").join("") + "</ul>";
        if (typeof v === "object") { const KM = {target:"目标人群",materials:"核心物料",staffing:"人力配置",conversion:"转化承接",risk:"风险控制",time:"时间",item:"事项"}; return Object.entries(v).map(([k,val]) => '<div class="row"><span class="k">' + e2(KM[k]||k) + '</span><div class="v">' + rv(val) + "</div></div>").join(""); }
        return e2(v).replace(/\n/g, "<br>");
      };
      const sec = (t, v) => { const b = rv(v); return b ? "<section><h2>" + t + "</h2>" + b + "</section>" : ""; };
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + e2(a.title) + ' - SOP</title><style>'
        + "body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#2d2a26;max-width:780px;margin:0 auto;padding:32px 24px;line-height:1.8}"
        + ".head{border-bottom:3px solid #c8742c;padding-bottom:16px;margin-bottom:24px}"
        + "h1{font-size:26px;margin:0 0 8px}"
        + ".meta{display:flex;flex-wrap:wrap;gap:8px 24px;font-size:14px;color:#6b6258;margin-top:10px}.meta b{color:#c8742c}"
        + "section{margin-bottom:22px;page-break-inside:avoid}"
        + "h2{font-size:17px;color:#c8742c;border-left:4px solid #c8742c;padding-left:10px;margin:0 0 10px}"
        + "ul{margin:6px 0;padding-left:22px}li{margin:4px 0}"
        + '.row{display:flex;gap:12px;margin:6px 0}.k{flex:0 0 110px;font-weight:600;color:#8a5a23}.v{flex:1}'
        + ".foot{margin-top:32px;padding-top:12px;border-top:1px solid #e5ded4;font-size:12px;color:#a39a8d;text-align:center}"
        + "@media print{body{padding:0}}"
        + "</style></head><body>"
        + '<div class="head"><h1>' + e2(a.title) + '</h1><div class="meta">'
        + "<span>参考价格 <b>" + e2(a.price||"-") + "</b></span>"
        + "<span>适合人数 <b>" + e2(a.capacity||"-") + "</b></span>"
        + "<span>活动时长 <b>" + e2(a.duration||"-") + "</b></span>"
        + "<span>推荐地点 <b>" + e2(a.location||"-") + "</b></span>"
        + "</div></div>"
        + sec("活动介绍", a.intro)
        + "<section><h2>执行三阶段</h2><div class=\'row\'><span class=\'k\'>📋 活动前</span><div class=\'v\'>确认报名人数、场地动线、物料备齐、老师/摄影落实、用户提醒和应急预案。</div></div><div class=\'row\'><span class=\'k\'>🎯 活动中</span><div class=\'v\'>先签到分组，再破冰控场，确保每个用户都有被照顾和被记录的体验点。</div></div><div class=\'row\'><span class=\'k\'>✅ 活动后</span><div class=\'v\'>24小时内发布作品，复盘用户标签，私聊反馈，并承接下次活动或课程。</div></div></section>"
        + sec("活动亮点", a.highlights)
        + sec("执行方案", a.plan)
        + (Array.isArray(a.schedule) && a.schedule.length ? "<section><h2>活动流程</h2><table style=\'width:100%;border-collapse:collapse\'>" + a.schedule.map(s => "<tr><td style=\'width:90px;padding:7px 10px;border-bottom:1px solid #eee8de;font-weight:600;color:#c8742c;white-space:nowrap;vertical-align:top\'>" + e2(s.time||"") + "</td><td style=\'padding:7px 10px;border-bottom:1px solid #eee8de\'>" + e2(s.item||"") + "</td></tr>").join("") + "</table></section>" : "")
        + '<div class="foot">开开华彩 · 活动SOP学习平台 · 打印时选择「另存为PDF」即可保存</div>'
        + "<scr" + "ipt>window.onload=()=>setTimeout(()=>window.print(),300);</scr" + "ipt></body></html>";
      const w = window.open("", "_blank");
      w.document.write(html);
      w.document.close();
      dlBtn.textContent = "✓ 已生成";
      setTimeout(() => dlBtn.textContent = "⬇ 下载 SOP", 2000);
    } catch (err) { alert(err.message); }
  });
  });

  // 点赞
  document.querySelectorAll("[data-like]").forEach(btn => {
    btn.addEventListener("click", () => {
      const count = btn.querySelector(".like-count");
      const liked = btn.classList.toggle("liked");
      count.textContent = parseInt(count.textContent) + (liked ? 1 : -1);
    });
  });

  // 发帖
  // ---- 发布经验（真实接口） ----
  const submitBtn = document.querySelector("#submitPostBtn");
  const ta = document.querySelector("#postTextarea");
  const upBtn = document.querySelector("#uploadImgBtn");
  let pendingImgs = [];
  if (upBtn) {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);
    upBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const files = [...fileInput.files].slice(0, 3 - pendingImgs.length);
      files.forEach(f => {
        const r = new FileReader();
        r.onload = ev => {
          pendingImgs.push(ev.target.result);
          upBtn.textContent = "📎 已选 " + pendingImgs.length + " 张";
        };
        r.readAsDataURL(f);
      });
      fileInput.value = "";
    });
  }
  if (submitBtn && ta) {
    submitBtn.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) { alert("请先输入内容"); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = "发布中...";
      try {
        await api("/api/posts", { method: "POST", body: { activityId: a.id, content: text, images: pendingImgs } });
        ta.value = "";
        pendingImgs = [];
        if (upBtn) upBtn.textContent = "📎 上传图片";
        alert("发布成功！内容将在管理员审核通过后对其他用户可见。");
        await loadPosts();
      } catch (e) { alert(e.message || "发布失败"); }
      submitBtn.disabled = false;
      submitBtn.textContent = "发布经验";
    });
  }
  // ---- 加载留言列表 ----
  async function loadPosts() {
    try {
      const r = await fetch("/api/posts?activityId=" + encodeURIComponent(a.id)).then(x => x.json());
      const posts = r.posts || [];
      const wrap = document.querySelector("#postsList");
      if (!wrap) return;
      if (!posts.length) {
        wrap.innerHTML = '<div style="text-align:center;color:var(--muted);padding:24px 0;font-size:14px">还没有经验分享，来发布第一条吧</div>';
        return;
      }
      const fmtTime = iso => {
        const d = new Date(iso); const diff = (Date.now() - d.getTime()) / 86400000;
        if (diff < 1) return "今天"; if (diff < 2) return "昨天";
        if (diff < 7) return Math.floor(diff) + "天前";
        return d.getMonth() + 1 + "月" + d.getDate() + "日";
      };
      wrap.innerHTML = posts.map(p => `
        <div class="post-card" style="background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px${(p.status||'approved')!=='approved' ? ';opacity:0.75;border-style:dashed' : ''}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div class="author-avatar">${esc((p.author || "用").slice(0, 1))}</div>
            <div style="flex:1">
              <div style="font-weight:600;font-size:14px">${esc(p.author)}</div>
              <div style="font-size:12px;color:var(--muted)">${esc(p.role || "")}</div>
            </div>
            <span style="font-size:12px;color:var(--muted)">${fmtTime(p.createdAt)}</span>${(p.status||'approved')!=='approved' ? '<span style="font-size:12px;color:#c8742c;margin-left:8px;background:#fdf3ea;padding:2px 8px;border-radius:10px">待审核</span>' : ''}
          </div>
          <div style="font-size:14px;line-height:1.8;white-space:pre-wrap">${esc(p.content)}</div>
          ${(p.images || []).length ? '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' + p.images.map(u => `<img src="${esc(u)}" style="width:120px;height:90px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="window.open('${esc(u)}')">`).join("") + "</div>" : ""}
        </div>`).join("");

    } catch (e) {}
  }
  loadPosts();

  bindAuthEvents();
}

// ---- 数据加载 ----
async function loadList() {
  const p = new URLSearchParams();
  Object.entries(state.filters).forEach(([k,v]) => v && p.set(k,v));
  const data = await api(`/api/public/activities?${p}`);
  state.activities = data.activities || [];
  state.cities = data.cities || [];
  state.categories = data.categories || [];
  renderList();
}

async function loadDetail(id) {
  const data = await api(`/api/public/activities/${encodeURIComponent(id)}`);
  state.activeTab = "intro";
  renderDetail(data.activity);
}

function startHeroCarousel(activities) {
  const banners = state.banners || [];
  if (banners.length >= 2) {
    let idx = 0;
    const go = (n) => {
      idx = n;
      document.querySelectorAll(".banner-slide").forEach((el,i) => el.style.opacity = i===n?"1":"0");
      document.querySelectorAll(".banner-dot").forEach((el,i) => { el.style.background = i===n?"var(--accent)":"rgba(255,255,255,0.5)"; });
    };
    document.querySelectorAll(".banner-dot").forEach((dot,i) => dot.addEventListener("click", () => { go(i); clearInterval(timer); timer = setInterval(() => go((idx+1)%banners.length), 5000); }));
    let timer = setInterval(() => go((idx+1)%banners.length), 5000);
    go(0);
    return;
  }
  const featuredIds = (state.siteConfig && state.siteConfig.featuredIds) || [];
  let items = featuredIds.length > 0
    ? featuredIds.map(id => activities.find(a => a.id === id)).filter(Boolean)
    : activities.filter(a => a.cover && a.status === "published").slice(0, 5);
  if (!items.length) items = activities.filter(a => a.cover).slice(0, 5);
  if (items.length < 2) return;
  let idx = 0;
  setInterval(() => {
    idx = (idx + 1) % items.length;
    const mainImg = document.querySelector("#heroMainImg");
    if (!mainImg) return;
    mainImg.style.opacity = "0";
    setTimeout(() => { mainImg.src = items[idx].cover; mainImg.style.opacity = "1"; }, 500);
  }, 5000);
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
  } catch { state.user = null; }
  try { const sc = await api('/api/site-config'); state.siteConfig = sc.config || {}; } catch {}
  try { const br = await fetch('/api/banners').then(r=>r.json()); state.banners = br.banners || []; } catch(e) { state.banners = []; }
  if (!state.user) { state.loginOpen = true; }
  setTimeout(() => startHeroCarousel(state.activities || []), 1000);
  try {
    const match = location.pathname.match(/^\/activity\/([^/]+)$/);
    if (match) await loadDetail(decodeURIComponent(match[1]));
    else await loadList();
  } catch (err) {
    app.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

boot();
