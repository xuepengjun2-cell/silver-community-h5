const app = document.querySelector("#app");

const state = {
  activities: [],
  cities: [],
  categories: [],
  user: null,
  loginOpen: false,
  authMessage: "",
  currentActivity: null,
  filters: {
    q: "",
    city: "",
    category: ""
  }
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function optionList(items, selected, label) {
  return `<option value="">${label}</option>${items.map(item => `<option value="${esc(item)}" ${item === selected ? "selected" : ""}>${esc(item)}</option>`).join("")}`;
}

function roleLabel(role) {
  return {
    admin: "总部管理员",
    operator: "城市主理人",
    viewer: "只读账号",
    member: "学习用户"
  }[role] || role;
}

function userCanDownload() {
  return Boolean(state.user && (state.user.canDownload || ["admin", "operator"].includes(state.user.role)));
}

function authBar() {
  if (!state.user) {
    return `<button class="btn secondary small" type="button" data-open-login>登录学习</button>`;
  }
  return `
    <div class="user-chip">
      <span>${esc(state.user.name || state.user.username)}</span>
      <em>${esc(roleLabel(state.user.role))}</em>
    </div>
    <button class="text-btn" type="button" id="logoutBtn">退出</button>
  `;
}

function loginModal() {
  if (!state.loginOpen) return "";
  return `
    <div class="modal-mask">
      <form class="login-modal" id="loginForm">
        <button class="modal-close" type="button" data-close-login>×</button>
        <h2>登录后学习活动 SOP</h2>
        <p>普通用户可查看新手提醒和 SOP 学习内容，下载权限由管理员单独开通。</p>
        ${state.authMessage ? `<div class="message error">${esc(state.authMessage)}</div>` : ""}
        <div class="field">
          <label>账号</label>
          <input class="input" name="username" autocomplete="username" value="member">
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" name="password" type="password" autocomplete="current-password" value="member123">
        </div>
        <button class="btn" type="submit">进入学习</button>
        <span class="help">演示普通用户：member / member123；管理员：admin / admin123。</span>
      </form>
    </div>
  `;
}

function rerenderCurrent() {
  if (state.currentActivity) renderDetail(state.currentActivity);
  else renderList();
}

function bindAuthEvents() {
  document.querySelectorAll("[data-open-login]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.loginOpen = true;
      state.authMessage = "";
      rerenderCurrent();
    });
  });
  document.querySelectorAll("[data-close-login]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.loginOpen = false;
      state.authMessage = "";
      rerenderCurrent();
    });
  });
  const logoutBtn = document.querySelector("#logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await requestJson("/api/logout", { method: "POST", body: {} });
      state.user = null;
      rerenderCurrent();
    });
  }
  const loginForm = document.querySelector("#loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const data = await requestJson("/api/login", {
          method: "POST",
          body: {
            username: form.get("username"),
            password: form.get("password")
          }
        });
        state.user = data.user;
        state.loginOpen = false;
        state.authMessage = "";
        rerenderCurrent();
      } catch (error) {
        state.authMessage = error.message;
        rerenderCurrent();
      }
    });
  }
}

function activityCard(activity) {
  const tags = (activity.tags || []).slice(0, 3).map(tag => `<span class="pill">${esc(tag)}</span>`).join("");
  return `
    <article class="activity-card">
      <img src="${esc(activity.cover || "/assets/people/cn-social-cafe.jpg")}" alt="${esc(activity.title)}">
      <div class="card-body">
        <div class="meta-row">
          <span class="pill">${esc(activity.city || "同城")}</span>
          <span class="pill gold">${esc(activity.category || "活动")}</span>
        </div>
        <h3>${esc(activity.title)}</h3>
        <p>${esc(activity.intro)}</p>
        <div class="tags">${tags}</div>
        <div class="card-actions">
          <span class="price">${esc(activity.price || "咨询主理人")}</span>
          <a class="btn" href="/activity/${encodeURIComponent(activity.id)}">学习方案</a>
        </div>
      </div>
    </article>
  `;
}

function groupActivities(activities) {
  const map = new Map();
  activities.forEach(activity => {
    const category = activity.category || "其他活动";
    if (!map.has(category)) map.set(category, []);
    map.get(category).push(activity);
  });
  return [...map.entries()].map(([category, activities], index) => ({
    category,
    activities,
    anchor: `cat-${index + 1}`
  }));
}

function quickEntryCard(group, index) {
  return `
    <a class="quick-card" href="#${esc(group.anchor)}">
      <span>大类 ${index + 1}</span>
      <strong>${esc(group.category)}</strong>
      <em>共 ${group.activities.length} 个方案</em>
    </a>
  `;
}

function categorySection(group, index) {
  return `
    <section class="category-section" id="${esc(group.anchor)}">
      <div class="category-title">
        <span>大类 ${index + 1}</span>
        <h3>${esc(group.category)}</h3>
        <p>${group.activities.length} 个标准活动方案</p>
      </div>
      <div class="activity-grid">
        ${group.activities.map(activityCard).join("")}
      </div>
    </section>
  `;
}

function renderList() {
  state.currentActivity = null;
  const first = state.activities[0];
  const groups = groupActivities(state.activities);
  const quickEntries = groups.slice(0, 5);
  app.className = "app-shell";
  app.innerHTML = `
    <header class="site-header">
      <a class="brand-mark" href="/">
        <span></span>
        <strong>开开华彩</strong>
      </a>
      <nav>
        <a href="#quick-entry">快速入口</a>
        <a href="#activity-list">活动库</a>
        <a href="/admin">管理后台</a>
        <div class="auth-actions">${authBar()}</div>
      </nav>
    </header>
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">同城主理人活动 SOP 库</span>
        <h1>让新手也能照着执行的活动方案学习网站</h1>
        <p>把活动图片、流程、物料、人力配置、转化承接和风险提醒沉淀成可学习、可下载、可审核上架的标准化活动库。</p>
        <div class="hero-actions">
          <a class="btn" href="#activity-list">查看活动库</a>
          ${state.user ? `<a class="btn secondary" href="/admin">进入后台</a>` : `<button class="btn secondary" type="button" data-open-login>登录学习</button>`}
        </div>
        <div class="hero-metrics" aria-label="活动库概览">
          <div><strong>${state.activities.length}</strong><span>标准活动方案</span></div>
          <div><strong>${groups.length}</strong><span>运营大类</span></div>
          <div><strong>SOP</strong><span>授权学习下载</span></div>
        </div>
      </div>
      <div class="hero-panel">
        <img src="${esc(first?.cover || "/assets/people/cn-social-cafe.jpg")}" alt="活动展示">
        <div class="hero-badge">
          <div>
            <strong>${esc(first?.title || "精选活动")}</strong>
            <span>${esc(first?.city || "同城")} · ${esc(first?.category || "银发社群")}</span>
          </div>
          ${first ? `<a class="btn secondary" href="/activity/${encodeURIComponent(first.id)}">学习</a>` : ""}
        </div>
      </div>
    </section>
    <section class="quick-entry" id="quick-entry">
      <div class="section-head">
        <div>
          <h2>快速跳转</h2>
          <p>按活动大类进入，适合主理人快速筛选本周可做的同城活动。</p>
        </div>
      </div>
      <div class="quick-grid">
        ${quickEntries.map(quickEntryCard).join("")}
      </div>
    </section>
    <section id="activity-list">
      <div class="section-head">
        <div>
          <h2>活动方案库</h2>
          <p>按城市、类型和关键词筛选，快速找到适合主理人推广和学习的活动 SOP。</p>
        </div>
      </div>
      <div class="filters">
        <input class="input" id="q" placeholder="搜索活动、标签、城市" value="${esc(state.filters.q)}">
        <select class="select" id="city">${optionList(state.cities, state.filters.city, "全部城市")}</select>
        <select class="select" id="category">${optionList(state.categories, state.filters.category, "全部大类")}</select>
      </div>
      <div class="category-groups">
        ${groups.length ? groups.map(categorySection).join("") : `<div class="empty">暂时没有符合条件的活动</div>`}
      </div>
    </section>
    ${loginModal()}
  `;

  document.querySelector("#q").addEventListener("input", event => {
    state.filters.q = event.target.value.trim();
    window.clearTimeout(window.__filterTimer);
    window.__filterTimer = window.setTimeout(loadList, 240);
  });
  document.querySelector("#city").addEventListener("change", event => {
    state.filters.city = event.target.value;
    loadList();
  });
  document.querySelector("#category").addEventListener("change", event => {
    state.filters.category = event.target.value;
    loadList();
  });
  bindAuthEvents();
}

async function loadList() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const data = await requestJson(`/api/public/activities?${params.toString()}`);
  state.activities = data.activities || [];
  state.cities = data.cities || [];
  state.categories = data.categories || [];
  renderList();
}

function fact(label, value, variant = "") {
  if (!value) return "";
  return `<div class="fact ${esc(variant)}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function planItem(label, value) {
  if (!value) return "";
  return `<div class="plan-item"><strong>${esc(label)}</strong><p>${esc(value)}</p></div>`;
}

function linkList(items, emptyText) {
  const urls = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!urls.length) return `<p class="muted">${esc(emptyText)}</p>`;
  return `
    <div class="resource-list">
      ${urls.map((url, index) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">参考资料 ${index + 1}</a>`).join("")}
    </div>
  `;
}

function sopLearningPanel(activity) {
  if (!state.user) {
    return `
      <div class="panel wide locked-panel">
        <h2>SOP 学习区</h2>
        <p>登录后可查看新手执行提醒、活动前中后检查项，并在权限开通后下载完整 SOP。</p>
        <button class="btn" type="button" data-open-login>登录学习</button>
      </div>
    `;
  }
  const downloadHtml = activity.downloadEnabled === false
    ? `<span class="download-note">该活动暂未开放 SOP 下载。</span>`
    : userCanDownload()
      ? `<button class="btn" type="button" id="downloadSopBtn">下载SOP</button><span class="download-note" id="downloadTip">下载后可发给新手主理人做执行清单。</span>`
      : `<span class="download-note">当前账号只能学习，暂未开通下载权限。</span>`;
  return `
    <div class="panel wide">
      <h2>SOP 学习区</h2>
      <div class="learning-grid">
        <div class="learning-card">
          <strong>活动前</strong>
          <p>确认报名人数、场地动线、物料、老师/摄影、用户提醒和应急预案。</p>
        </div>
        <div class="learning-card">
          <strong>活动中</strong>
          <p>先签到分组，再破冰控场，确保每个用户都有被照顾和被记录的体验点。</p>
        </div>
        <div class="learning-card">
          <strong>活动后</strong>
          <p>24小时内发布作品、复盘用户标签、私聊反馈，并承接下一次活动或课程。</p>
        </div>
      </div>
      <div class="download-box">
        ${downloadHtml}
      </div>
    </div>
  `;
}

function renderDetail(activity) {
  state.currentActivity = activity;
  const images = activity.images?.length ? activity.images : [activity.cover].filter(Boolean);
  const highlights = (activity.highlights || []).map(x => `<li>${esc(x)}</li>`).join("");
  const timeline = (activity.schedule || []).map(x => `
    <div class="timeline-row">
      <time>${esc(x.time)}</time>
      <div>${esc(x.item)}</div>
    </div>
  `).join("");
  app.className = "app-shell detail-shell";
  app.innerHTML = `
    <nav class="top-nav">
      <a class="btn secondary" href="/">返回活动库</a>
      <div class="auth-actions">${authBar()}</div>
    </nav>
    <section class="detail-hero">
      <div class="detail-cover">
        <img src="${esc(activity.cover || images[0] || "/assets/people/cn-social-cafe.jpg")}" alt="${esc(activity.title)}">
      </div>
      <div class="detail-copy">
        <div class="meta-row">
          <span class="pill">${esc(activity.city || "同城")}</span>
          <span class="pill">${esc(activity.region || activity.city || "地区待补充")}</span>
          <span class="pill gold">${esc(activity.category || "活动")}</span>
        </div>
        <h1>${esc(activity.title)}</h1>
        <p>${esc(activity.intro)}</p>
        <div class="facts" aria-label="活动关键参数">
          ${fact("价格", activity.price, "wide primary")}
          ${fact("人数", activity.capacity)}
          ${fact("时长", activity.duration)}
          ${fact("地点", activity.location, "wide")}
          ${fact("类型", activity.activityType, "compact")}
        </div>
      </div>
    </section>
    <section class="content-grid">
      ${sopLearningPanel(activity)}
      <div class="panel">
        <h2>活动亮点</h2>
        <ul class="list">${highlights || "<li>主理人可在后台补充活动亮点。</li>"}</ul>
      </div>
      <div class="panel">
        <h2>活动流程</h2>
        <div class="timeline">${timeline || "<div class='timeline-row'><time>待定</time><div>主理人可在后台补充流程。</div></div>"}</div>
      </div>
      <div class="panel wide">
        <h2>执行方案</h2>
        <div class="plan-grid">
          ${planItem("运营目标", activity.plan?.target)}
          ${planItem("核心物料", activity.plan?.materials)}
          ${planItem("人力配置", activity.plan?.staffing)}
          ${planItem("转化承接", activity.plan?.conversion)}
          ${planItem("风险控制", activity.plan?.risk)}
        </div>
      </div>
      <div class="panel wide">
        <h2>图片与视频参考</h2>
        <div class="gallery">
          ${images.map(src => `<img src="${esc(src)}" alt="${esc(activity.title)}">`).join("")}
        </div>
        <div class="resource-grid">
          <div>
            <strong>视频参考</strong>
            ${linkList(activity.videos, "后台可继续补充视频链接。")}
          </div>
          <div>
            <strong>方案参考</strong>
            ${linkList(activity.references, "后台可继续补充参考链接。")}
          </div>
        </div>
      </div>
    </section>
    <div class="sticky-cta">
      <span>${esc(activity.contact || "联系主理人获取报名名额")}</span>
      <button class="btn" id="copyBtn">复制活动链接</button>
    </div>
    ${loginModal()}
  `;
  document.querySelector("#copyBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    document.querySelector("#copyBtn").textContent = "已复制";
    window.setTimeout(() => {
      document.querySelector("#copyBtn").textContent = "复制活动链接";
    }, 1400);
  });
  const downloadBtn = document.querySelector("#downloadSopBtn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", async () => {
      const tip = document.querySelector("#downloadTip");
      try {
        const res = await fetch(`/api/public/activities/${encodeURIComponent(activity.id)}/download`, { credentials: "same-origin" });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "下载失败");
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${activity.title}-SOP.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (tip) tip.textContent = "SOP 已开始下载。";
      } catch (error) {
        if (tip) tip.textContent = error.message;
      }
    });
  }
  bindAuthEvents();
}

async function loadDetail(id) {
  const data = await requestJson(`/api/public/activities/${encodeURIComponent(id)}`);
  renderDetail(data.activity);
}

async function consumeActivityHubSsoTicket() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("activity_sso");
  if (!token) return false;
  try {
    const data = await requestJson("/api/auth/sso", {
      method: "POST",
      body: { token }
    });
    state.user = data.user;
  } catch (error) {
    state.authMessage = "免密进入未完成：" + error.message + "。你仍可使用活动平台原账号登录。";
    state.loginOpen = true;
  } finally {
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }
  return true;
}

async function boot() {
  const ssoAttempted = await consumeActivityHubSsoTicket();
  try {
    if (!state.user) {
      const me = await requestJson("/api/me");
      state.user = me.user;
    }
  } catch {
    state.user = null;
  }
  if (ssoAttempted && !state.user) state.loginOpen = true;
  try {
    const detailMatch = location.pathname.match(/^\/activity\/([^/]+)$/);
    if (detailMatch) {
      await loadDetail(decodeURIComponent(detailMatch[1]));
    } else {
      await loadList();
    }
  } catch (error) {
    app.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

boot();
