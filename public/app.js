// =============================================
//  开开华彩 · 活动 SOP 平台 · 前台逻辑
// =============================================

const app = document.querySelector("#app");

const state = {
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
        <span class="help">演示账号：member / member123 &nbsp;|&nbsp; 管理员：admin / admin123</span>
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
    state.user = null; rerenderCurrent();
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
        <p>精选 ${state.activities.length} 套活动方案，包含完整执行流程、物料清单、价格参考、风险控制，主理人学习即可落地执行。</p>
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
        <img class="hero-img-main" src="${esc(first?.cover || "/assets/people/cn-social-cafe.jpg")}" alt="活动展示">
        ${state.activities[3] ? `<img class="hero-img-float" src="${esc(state.activities[3].cover || "/assets/people/cn-social-cafe.jpg")}" alt="活动展示">` : ""}
        <div class="hero-badge">
          <strong>${esc(first?.title || "精选活动方案")}</strong>
          <span>${esc(first?.city || "同城")} · ${esc(first?.category || "银发社群")}</span>
        </div>
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
  const mockPosts = [
    {
      id: 1, featured: true,
      author: "上海·晓蝶", city: "上海", role: "城市主理人",
      time: "2天前",
      content: "上周六在静安区办了这个活动，到场42人，效果超出预期！几点经验分享给大家：\n\n① 场地选了社区图书馆的多功能厅，免费申请，比租场地省了600元，叔叔阿姨们觉得文化气息更浓\n\n② 报名群里提前3天发了「点歌征集」，大家已经在群里互动起来，活动还没开始就热身了\n\n③ 最后加了个「高光时刻投票」环节，每人选出最心动的3个唱段，结果比主持人点评还热闹，有几位平时内敛的叔叔当场表演返场！\n\n下次打算试试加入乐器伴奏，有会吹口琴的主理人可以交流！",
      likes: 47, comments: 11, imgs: []
    },
    {
      id: 2, featured: true,
      author: "杭州·文博", city: "杭州", role: "城市主理人",
      time: "4天前",
      content: "分享一个物料采购的省钱经验：闪光棒在义乌小商品批发市场（1688搜「荧光棒批发」）0.8元一根，买50根起批，比淘宝零售便宜60%。大字歌单我们改成了A3投影版，省去打印费还更清晰。\n\n整场下来人均物料成本控制在6元以内，这样即使按69元/人收费，毛利空间还算可观。",
      likes: 63, comments: 18, imgs: []
    },
    {
      id: 3, featured: false,
      author: "成都·阿伟", city: "成都", role: "城市主理人",
      time: "6天前",
      content: "问一下大家：我们城市的KTV普遍要求最低消费，有没有好的谈判技巧？上次谈了半天最后还是多付了饮料费，感觉钱都被场地赚走了。",
      likes: 22, comments: 9, imgs: []
    },
    {
      id: 4, featured: false,
      author: "北京·晓梅", city: "北京", role: "学习用户",
      time: "1周前",
      content: "我把这个SOP下载后针对社区老年活动中心做了改版，主要改动：\n1. 人数上限从40人提高到60人（分两组，每组30人交替上场）\n2. 时长改为4小时，中间加了20分钟茶歇\n3. 增加了「家人合唱」特别环节——邀请带着子女参加的叔叔阿姨，和孩子同台演唱\n\n改版后满意度反而更高了，有需要这个版本的主理人可以私聊我。",
      likes: 38, comments: 14, imgs: []
    },
    {
      id: 5, featured: false,
      author: "广州·小雅", city: "广州", role: "城市主理人",
      time: "9天前",
      content: "提醒一下南方城市的主理人：6-9月高温季节，如果KTV空调不够强，叔叔阿姨唱完容易不舒服。我们现在会在签到时发一瓶冰矿泉水，成本3毛钱，但用户满意度提升明显。\n\n另外建议把活动时间改到傍晚5-8点，避开午间热浪，报名转化率也更高。",
      likes: 29, comments: 7, imgs: []
    },
    {
      id: 6, featured: false,
      author: "深圳·大强", city: "深圳", role: "学习用户",
      time: "2周前",
      content: "刚下载了SOP，准备本月底在福田区试跑第一场。有没有已经办过的主理人可以帮我看看场地选择？我找了两个候选地：一个是商场内的KTV（人流多但嘈杂），一个是社区文化活动室（安静但需要自备设备）。大家怎么看？",
      likes: 15, comments: 12, imgs: []
    }
  ];

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
          <p>分享执行心得、踩坑记录、本地化改良方案；优质内容可申请提交为正式活动方案，经总部审核后上架展示。</p>
        </div>
        <button class="btn small ghost" style="white-space:nowrap" ${state.user ? "" : "data-open-login"}>
          📝 提交我的方案
        </button>
      </div>
      ${composeBlock}
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
  const copyBtn = document.querySelector("#copyBtn");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    copyBtn.textContent = "✓ 已复制";
    setTimeout(() => copyBtn.textContent = "复制链接", 1500);
  });

  // 下载 SOP
  const dlBtn = document.querySelector("#downloadSopBtn");
  if (dlBtn) dlBtn.addEventListener("click", async () => {
    const tip = document.querySelector("#downloadTip");
    try {
      const res = await fetch(`/api/public/activities/${encodeURIComponent(a.id)}/download`, { credentials:"same-origin" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "下载失败"); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${a.title}-SOP.txt`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      if (tip) tip.textContent = "✓ SOP 已开始下载";
      dlBtn.textContent = "✓ 已下载";
      setTimeout(() => dlBtn.textContent = "⬇ 下载 SOP", 2000);
    } catch (err) {
      if (tip) tip.textContent = err.message;
    }
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
  const submitBtn = document.querySelector("#submitPostBtn");
  if (submitBtn) submitBtn.addEventListener("click", () => {
    const ta = document.querySelector("#postTextarea");
    if (!ta || !ta.value.trim()) return;
    alert("感谢分享！内容审核后将显示在交流区。");
    ta.value = "";
  });

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

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
  } catch { state.user = null; }
  try {
    const match = location.pathname.match(/^\/activity\/([^/]+)$/);
    if (match) await loadDetail(decodeURIComponent(match[1]));
    else await loadList();
  } catch (err) {
    app.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

boot();
