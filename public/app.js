// =============================================
//  开开华彩 · 活动 SOP 平台 · 前台逻辑
// =============================================

const app = document.querySelector("#app");
const SILVER_FRONT_BASE = "https://proj2.likeduoduiyi.cn/silver";
const SILVER_API_BASE = "https://apip2.kkhuacai08.cn/silver-api";
const AUTH_TOKEN_KEY = "silver_auth_token";

const state = {
  siteConfig: {},
  banners: [],
  activities: [],
  cities: [],
  categories: [],
  user: null,
  loginOpen: false,
  authMessage: "",
  authTab: "login",
  contributeOpen: false,
  contributeMsg: "",
  contributeOk: false,
  contributeStep: "basic",
  contributeDraft: {},
  contributeImages: [],
  contributeRows: [{ time: "", item: "" }],
  currentActivity: null,
  activeTab: "intro",
  selectedActivityMedia: null,
  projects: [],
  currentProject: null,
  projectView: "",
  projectCreateOpen: false,
  projectMetaEditOpen: false,
  projectMediaTab: "",
  projectPreviewIndex: null,
  projectPreviewMode: false,
  selectedProjectMediaIndex: null,
  projectLightboxIndex: null,
  sessionToken: localStorage.getItem(AUTH_TOKEN_KEY) || "",
  cases: [],
  homeCases: [],
  homeCasesLoaded: false,
  caseCategories: [],
  caseFilter: "",
  caseView: false,
  activeCaseId: "",
  caseMediaTab: "",
  selectedCaseMediaIndex: null,
  favorites: new Set(JSON.parse(localStorage.getItem("kk_favs") || "[]")),
  filters: { q: "", city: "", category: "" }
};
const HERO_CASE_LIMIT = 10;
let lastAuditedCaseId = "";

// ---- 工具函数 ----
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
    credentials: "include",
    headers,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return normalizeUrls(data);
}

async function trackMediaView(resourceType, resourceId, mediaIndex) {
  try {
    await api("/api/audit-events", {
      method: "POST",
      body: { action: "view", resourceType, resourceId, mediaIndex }
    });
  } catch {
    // 观看埋点失败不能影响素材打开和播放。
  }
}

function apiUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/api/")) return SILVER_API_BASE + url.slice(4);
  if (url.startsWith("/uploads/")) return SILVER_API_BASE + url;
  return url;
}

async function uploadPublicImageFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const headers = {};
  if (state.sessionToken) headers.Authorization = `Bearer ${state.sessionToken}`;
  const res = await fetch(apiUrl(`/api/my-upload-image?ext=${encodeURIComponent(ext)}`), {
    method: "POST",
    credentials: "include",
    headers,
    body: file
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "图片上传失败");
  return normalizeUrls(data);
}

function publicUrl(url) {
  const raw = String(url || "");
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) return raw;
  if (raw.startsWith("/uploads/")) return SILVER_API_BASE + raw;
  if (raw.startsWith("/assets/")) return SILVER_FRONT_BASE + raw;
  return raw;
}

function fallbackCover() {
  return SILVER_FRONT_BASE + "/assets/people/cn-social-cafe.jpg";
}

function imageUrl(url) {
  return publicUrl(url) || fallbackCover();
}

function normalizeUrls(value) {
  if (Array.isArray(value)) return value.map(normalizeUrls);
  if (!value || typeof value !== "object") return value;
  Object.keys(value).forEach((key) => {
    const item = value[key];
    const urlish = /(^url$|url$|cover$|image$|images$|banner|banners)/i.test(key);
    if (typeof item === "string" && urlish) {
      value[key] = publicUrl(item);
    } else if (Array.isArray(item) && urlish) {
      value[key] = item.map(x => typeof x === "string" ? publicUrl(x) : normalizeUrls(x));
    } else {
      value[key] = normalizeUrls(item);
    }
  });
  return value;
}

function homeHref() { return SILVER_FRONT_BASE + "/"; }
function adminHref() { return SILVER_FRONT_BASE + "/admin"; }
function activityHref(id) { return activityShareHref(id); }

async function copyShareLink(url) {
  if (navigator.clipboard?.writeText && window.isSecureContext !== false) {
    try {
      await navigator.clipboard.writeText(url);
      return;
    } catch {
      // 权限被浏览器拒绝时继续走兼容复制，不直接判定为失败。
    }
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      ok ? resolve() : reject(new Error("复制失败"));
    } catch (err) { reject(err); }
  });
}

function closeShareFallback() {
  document.querySelector("[data-share-fallback]")?.remove();
}

function showShareFallback({ url, title, copied = false }) {
  closeShareFallback();
  const wechat = isWeChatBrowser();
  const modal = document.createElement("div");
  modal.className = "share-fallback-mask";
  modal.dataset.shareFallback = "1";
  modal.innerHTML = `
    <section class="share-fallback" role="dialog" aria-modal="true" aria-labelledby="shareFallbackTitle">
      <button class="share-fallback-close" type="button" data-share-close aria-label="关闭">×</button>
      <div class="eyebrow"><span class="eyebrow-dot"></span>${wechat ? "微信分享" : "复制分享链接"}</div>
      <h2 id="shareFallbackTitle">${esc(title || "分享内容")}</h2>
      <p>${copied ? "链接已复制。" : "当前浏览器未能直接完成分享，请复制下面的链接。"}${wechat ? "返回微信聊天窗口后粘贴发送，或点击右上角“…”发送给朋友。" : "你也可以打开链接检查分享内容。"}</p>
      <div class="share-fallback-link-row">
        <input class="input" type="text" readonly value="${esc(url)}" aria-label="分享链接">
        <button class="btn small" type="button" data-share-copy>复制链接</button>
      </div>
      <div class="share-fallback-actions">
        <a class="btn secondary small" href="${esc(url)}" target="_blank" rel="noreferrer">打开链接</a>
        <button class="btn ghost small" type="button" data-share-close>关闭</button>
      </div>
    </section>`;
  document.body.appendChild(modal);
  const input = modal.querySelector("input");
  const copyButton = modal.querySelector("[data-share-copy]");
  const close = () => closeShareFallback();
  modal.querySelectorAll("[data-share-close]").forEach(button => button.addEventListener("click", close));
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  copyButton?.addEventListener("click", async () => {
    try {
      await copyShareLink(url);
      copyButton.textContent = "✓ 已复制";
      input?.select();
    } catch {
      copyButton.textContent = "请长按复制";
      input?.focus();
      input?.select();
    }
  });
  input?.focus();
  input?.select();
}

async function shareLink({ url, title, text, button }) {
  const original = button?.textContent || "分享到微信";
  // 微信内置浏览器不稳定支持 navigator.share，统一走复制链接，避免唤起失败后误判为分享失败。
  if (!isWeChatBrowser() && typeof navigator.share === "function") {
    try {
      const canShareUrl = typeof navigator.canShare !== "function" || navigator.canShare({ url });
      if (!canShareUrl) throw new Error("当前设备不支持该分享链接");
      await navigator.share({ title: title || document.title, text: text || "", url });
      if (button) button.textContent = "✓ 已分享";
      if (button) setTimeout(() => button.textContent = original, 1800);
      return true;
    } catch (err) {
      if (err?.name === "AbortError") return false;
    }
  }
  try {
    await copyShareLink(url);
    if (button) {
      button.textContent = /MicroMessenger/i.test(navigator.userAgent) ? "✓ 已复制，点右上角发送" : "✓ 链接已复制";
      setTimeout(() => button.textContent = original, 2200);
    }
    if (isWeChatBrowser()) showShareFallback({ url, title, copied: true });
    return true;
  } catch {
    if (button) {
      button.textContent = "请手动复制";
      setTimeout(() => button.textContent = original, 1800);
    }
    showShareFallback({ url, title });
    return false;
  }
}

function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent || "");
}

function projectWeChatTip() {
  if (!isWeChatBrowser()) return "";
  return `<aside class="project-wechat-tip" role="note"><strong>微信内打开提示</strong><span>如页面打不开，请点击右上角“…” → “在浏览器中打开”。单个素材分享会直接打开对应图片或视频预览，不要直接发送 TOS 文件地址。</span></aside>`;
}

function activityShareHref(id, mediaType, index) {
  const url = new URL(`${SILVER_FRONT_BASE}/`);
  url.searchParams.set("activity", id);
  if (mediaType && Number.isInteger(Number(index))) url.searchParams.set("media", `${mediaType}:${Number(index)}`);
  return url.href;
}

function parseActivityMediaSelection() {
  const raw = new URLSearchParams(location.search).get("media") || "";
  const match = raw.match(/^([a-z]+):(\d+)$/i);
  return match ? { type: match[1].toLowerCase(), index: Number(match[2]) } : null;
}

function caseShareHref(id, mediaIndex) {
  const url = new URL(`${SILVER_FRONT_BASE}/`);
  url.searchParams.set("view", "cases");
  url.searchParams.set("case", id);
  if (Number.isInteger(Number(mediaIndex))) url.searchParams.set("media", String(Number(mediaIndex)));
  return url.href;
}

function hasProjectMediaIndex(value) {
  return value !== null && value !== undefined && value !== "" && Number.isInteger(Number(value));
}

function projectPreviewHref(id, mediaIndex, manager = false) {
  const url = new URL(`${SILVER_FRONT_BASE}/`);
  url.searchParams.set("view", "project-preview");
  url.searchParams.set("project", id);
  if (manager) url.searchParams.set("mode", "manage");
  if (hasProjectMediaIndex(mediaIndex)) url.searchParams.set("media", String(Number(mediaIndex)));
  return url.href;
}

function projectShareHref(id, mediaIndex) {
  const url = new URL(`${SILVER_FRONT_BASE}/`);
  const selected = hasProjectMediaIndex(mediaIndex) ? `.${Number(mediaIndex)}` : "";
  // 使用短分享参数进入相册页；视频不再作为分享链接的第一落点，降低微信内置浏览器拦截和大文件预加载风险。
  url.searchParams.set("share", `${id}${selected}`);
  return url.href;
}

function parseProjectShareValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(.+?)(?:\.(\d+))?$/);
  if (!match || !match[1]) return null;
  return { projectId: match[1], mediaIndex: match[2] === undefined ? null : Number(match[2]) };
}

function opts(items, sel, label) {
  return `<option value="">${label}</option>${items.map(i =>
    `<option value="${esc(i)}" ${i === sel ? "selected" : ""}>${esc(i)}</option>`).join("")}`;
}

function roleLabel(r) {
  return { admin:"总部管理员", operator:"城市主理人", viewer:"只读账号", member:"学习用户" }[r] || r;
}

function canDownload() {
  return Boolean(state.user);
}

function saveFavs() {
  localStorage.setItem("kk_favs", JSON.stringify([...state.favorites]));
}

function rerenderCurrent() {
  if (state.projectView === "album" && state.currentProject) renderProjectAlbum(state.currentProject);
  else if (state.projectView === "manager" && state.currentProject) renderProjectManager(state.currentProject);
  else if (state.projectView === "preview" && state.currentProject) renderProjectPreview(state.currentProject, state.projectPreviewIndex, state.projectPreviewMode);
  else if (state.projectView === "hub") renderProjectsView();
  else if (state.caseView && state.activeCaseId) renderCasePage(state.activeCaseId);
  else if (state.caseView) renderCases();
  else if (state.currentActivity) renderDetail(state.currentActivity);
  else renderList();
}

// 静态托管版会把该函数改写为 apiUrl(u),本地版原样返回
function apiHref(u) { return apiUrl(u); }

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

function mobilePrimaryNav(active = "") {
  const activeClass = key => active === key ? " active" : "";
  const albumEntry = state.user
    ? `<a class="${activeClass("projects").trim()}" href="?view=projects">活动相册</a>`
    : `<button class="${activeClass("projects").trim()}" type="button" data-open-login>活动相册</button>`;
  return `<nav class="mobile-primary-nav" aria-label="主要活动入口">
    <a class="${activeClass("activities").trim()}" href="${homeHref()}#activity-list">活动库</a>
    <a class="${activeClass("cases").trim()}" href="?view=cases">精彩案例</a>
    ${albumEntry}
  </nav>`;
}

// ---- 登录弹窗 ----
function contributeRowsHtml() {
  return state.contributeRows.map((r, i) => `
    <div class="contribute-row" data-row="${i}">
      <input class="input contribute-time" data-c-time placeholder="14:00" value="${esc(r.time)}">
      <input class="input contribute-item" data-c-item placeholder="流程节点描述" value="${esc(r.item)}">
      <button type="button" class="contribute-del" data-c-del="${i}">×</button>
    </div>`).join("");
}

function contributeThumbsHtml() {
  return (state.contributeImages || []).map((url, i) => `
    <div class="contribute-thumb">
      <img src="${esc(url)}" alt="">
      ${i === 0 ? `<span class="contribute-cover-tag">封面</span>` : ""}
      <button type="button" class="contribute-thumb-del" data-img-del="${i}">×</button>
    </div>`).join("");
}

function contributeModal() {
  if (!state.contributeOpen) return "";
  const step = state.contributeStep || "basic";
  const d = state.contributeDraft || {};
  const msg = state.contributeMsg ? `<div class="message ${state.contributeOk?"":"error"}">${esc(state.contributeMsg)}</div>` : "";
  const tab = (k, n, t) => `<button type="button" class="form-tab ${step===k?"active":""}" data-c-step="${k}"><span class="form-tab-num">${n}</span>${t}</button>`;
  const dl = d.downloadEnabled === false ? "" : "checked";
  return `
    <div class="modal-mask">
      <form class="login-modal contribute-modal" id="contributeForm">
        <button class="modal-close" type="button" data-close-contribute>×</button>
        <h2>我要共创活动</h2>
        <p>提交你的活动方案，经总部审核通过后即可上线，供全国主理人学习。</p>
        ${msg}
        <div class="form-tabs">
          ${tab("basic","1","基本信息")}${tab("content","2","活动内容")}${tab("sop","3","执行方案")}${tab("media","4","素材&设置")}
        </div>

        <div class="form-pane ${step==="basic"?"active":""}">
          <div class="row two">
            <div class="field"><label>所属城市</label><input class="input" name="city" value="${esc(d.city)}" placeholder="例如：北京"></div>
            <div class="field"><label>地区备注</label><input class="input" name="region" value="${esc(d.region)}" placeholder="例如：朝阳区"></div>
          </div>
          <div class="row two">
            <div class="field"><label>活动大类</label><input class="input" name="category" value="${esc(d.category)}" placeholder="例如：同城社交与情感系列"></div>
            <div class="field"><label>细分活动类型</label><input class="input" name="activityType" value="${esc(d.activityType)}" placeholder="例如：KTV欢唱、掼蛋、旗袍走秀"></div>
          </div>
          <div class="field"><label>活动标题 *</label><input class="input" name="title" value="${esc(d.title)}" placeholder="简洁有力，10字以内最佳"></div>
          <div class="field"><label>活动简介</label><textarea class="input" name="intro" rows="3" placeholder="一段话说清楚这个活动是什么、适合谁、体验感是什么">${esc(d.intro)}</textarea></div>
          <div class="row two">
            <div class="field"><label>参考价格</label><input class="input" name="price" value="${esc(d.price)}" placeholder="例如：69元/人"></div>
            <div class="field"><label>适合人数</label><input class="input" name="capacity" value="${esc(d.capacity)}" placeholder="例如：20-40人"></div>
          </div>
          <div class="row two">
            <div class="field"><label>活动时长</label><input class="input" name="duration" value="${esc(d.duration)}" placeholder="例如：3小时"></div>
            <div class="field"><label>推荐地点</label><input class="input" name="location" value="${esc(d.location)}" placeholder="例如：同城KTV包厢"></div>
          </div>
          <div class="field"><label>报名/咨询提示</label><input class="input" name="contact" value="${esc(d.contact)}" placeholder="显示在详情页底部"></div>
        </div>

        <div class="form-pane ${step==="content"?"active":""}">
          <div class="field">
            <label>活动亮点（每行一条）</label>
            <textarea class="input" name="highlights" rows="4" placeholder="大字歌单&#10;副歌高光录制&#10;活动后群内作品发布">${esc(d.highlights)}</textarea>
          </div>
          <div class="field">
            <label>当日活动时间轴</label>
            <div id="contributeRowsBox">${contributeRowsHtml()}</div>
            <button type="button" class="btn secondary small" id="contributeAddRow" style="margin-top:8px">+ 添加时间节点</button>
          </div>
          <div class="field">
            <label>活动标签（用逗号分隔）</label>
            <input class="input" name="tags" value="${esc(d.tags)}" placeholder="例如：声乐,社交,怀旧">
          </div>
        </div>

        <div class="form-pane ${step==="sop"?"active":""}">
          <div class="row two">
            <div class="field"><label>🎯 活动定位与转化目标</label><textarea class="input" name="target" rows="2" placeholder="活动定位、适合人群、价格/规模、核心转化目标">${esc(d.target)}</textarea></div>
            <div class="field"><label>📦 所需物料</label><textarea class="input" name="materials" rows="2" placeholder="通用物料、专属物料、内容物料、转化物料">${esc(d.materials)}</textarea></div>
          </div>
          <div class="row two">
            <div class="field"><label>👥 人员分工</label><textarea class="input" name="staffing" rows="2" placeholder="主理人、主持/老师、签到、摄影、后勤、转化跟进分别负责什么">${esc(d.staffing)}</textarea></div>
            <div class="field"><label>🔄 话术与转化承接</label><textarea class="input" name="conversion" rows="2" placeholder="活动前沟通、活动中主持/转化话术、活动后私聊和群内承接">${esc(d.conversion)}</textarea></div>
          </div>
          <div class="field"><label>⚠️ 注意事项与风险预案</label><textarea class="input" name="risk" rows="2" placeholder="客户体验注意事项、安全预案、转化边界、内容沉淀要求、复盘要求">${esc(d.risk)}</textarea></div>
        </div>

        <div class="form-pane ${step==="media"?"active":""}">
          <div class="field">
            <label>活动图片（可上传多张，第一张作封面）</label>
            <label class="contribute-upload-zone" for="contributeImageInput">
              <div class="upload-icon">📷</div>
              <p>点击上传图片（支持多选）<br>支持 png/jpg/webp/gif，单张≤8MB</p>
              <input type="file" id="contributeImageInput" accept="image/*" multiple style="display:none">
            </label>
            <div class="contribute-thumbs" id="contributeThumbs">${contributeThumbsHtml()}</div>
          </div>
          <div class="field"><label>封面图地址（可选，留空则用上传的第一张）</label><input class="input" name="cover" value="${esc(d.cover)}" placeholder="也可直接粘贴图片链接"></div>
          <div class="field"><label>视频参考链接（每行一个）</label><textarea class="input" name="videos" rows="2" placeholder="可粘贴视频号、小程序或素材库链接">${esc(d.videos)}</textarea></div>
          <div class="field"><label>方案参考链接（每行一个）</label><textarea class="input" name="references" rows="2" placeholder="飞书文档、内部素材、方案链接">${esc(d.references)}</textarea></div>
          <label class="checkline" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="downloadEnabled" ${dl}>
            <span>允许登录用户导出可视化 SOP</span>
          </label>
        </div>

        <div class="form-actions" style="display:flex;align-items:center;gap:8px;margin-top:16px">
          <button class="btn" type="submit">提交申请</button>
          <button class="btn secondary" type="button" data-close-contribute>取消</button>
          <div style="display:flex;gap:6px;margin-left:auto">
            <button type="button" class="btn secondary small" data-c-nav="-1">← 上一步</button>
            <button type="button" class="btn secondary small" data-c-nav="1">下一步 →</button>
          </div>
        </div>
      </form>
    </div>`;
}

function loginModal() {
  if (!state.loginOpen) return "";
  const isLogin = state.authTab !== "register";
  const tabs = `
    <div class="auth-tabs">
      <button type="button" class="auth-tab ${isLogin?"active":""}" data-auth-tab="login">登录</button>
      <button type="button" class="auth-tab ${!isLogin?"active":""}" data-auth-tab="register">申请注册</button>
    </div>`;
  const msg = state.authMessage ? `<div class="message ${state.authOk?"":"error"}">${esc(state.authMessage)}</div>` : "";
  if (isLogin) {
    return `
    <div class="modal-mask">
      <form class="login-modal" id="loginForm">
        <button class="modal-close" type="button" data-close-login>×</button>
        <h2>登录学习平台</h2>
        <p>平台内容免费开放浏览，登录后即可导出可视化 SOP。</p>
        ${tabs}
        ${msg}
        <div class="field">
          <label>账号</label>
          <input class="input" name="username" autocomplete="username" placeholder="请输入账号">
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" name="password" type="password" autocomplete="current-password" placeholder="请输入密码">
        </div>
        <div style="display:flex;gap:10px;margin-top:4px">
          <button class="btn" type="submit" style="flex:1">进入学习</button>
          <button class="btn secondary" type="button" data-close-login>取消</button>
        </div>
      </form>
    </div>`;
  }
  return `
    <div class="modal-mask">
      <form class="login-modal" id="registerForm">
        <button class="modal-close" type="button" data-close-login>×</button>
        <h2>申请学习账号</h2>
        <p>提交申请后，管理员审核开通即可登录学习。</p>
        ${tabs}
        ${msg}
        <div class="field">
          <label>账号</label>
          <input class="input" name="username" autocomplete="username" placeholder="设置登录账号">
        </div>
        <div class="field">
          <label>姓名/昵称</label>
          <input class="input" name="name" placeholder="方便管理员识别">
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" name="password" type="password" autocomplete="new-password" placeholder="至少6位">
        </div>
        <div style="display:flex;gap:10px;margin-top:4px">
          <button class="btn" type="submit" style="flex:1">提交申请</button>
          <button class="btn secondary" type="button" data-close-login>取消</button>
        </div>
      </form>
    </div>`;
}

function bindAuthEvents() {
  document.querySelectorAll("[data-open-login]").forEach(btn =>
    btn.addEventListener("click", () => { state.loginOpen = true; state.authMessage = ""; state.authOk = false; state.authTab = "login"; rerenderCurrent(); }));

  document.querySelectorAll("[data-open-register]").forEach(btn =>
    btn.addEventListener("click", () => { state.loginOpen = true; state.authMessage = ""; state.authOk = false; state.authTab = "register"; rerenderCurrent(); }));
  document.querySelectorAll("[data-auth-tab]").forEach(btn =>
    btn.addEventListener("click", () => { state.authTab = btn.dataset.authTab; state.authMessage = ""; state.authOk = false; rerenderCurrent(); }));
  document.querySelectorAll("[data-close-login]").forEach(btn =>
    btn.addEventListener("click", () => { state.loginOpen = false; rerenderCurrent(); }));
  const logoutBtn = document.querySelector("#logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    await api("/api/logout", { method:"POST", body:{} });
    state.user = null; state.sessionToken = ""; localStorage.removeItem(AUTH_TOKEN_KEY); window.location.reload();
  });
  const loginForm = document.querySelector("#loginForm");
  if (loginForm) loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const data = await api("/api/login", { method:"POST", body:{ username:f.get("username"), password:f.get("password") } });
      state.user = data.user;
      if (data.token) { state.sessionToken = data.token; localStorage.setItem(AUTH_TOKEN_KEY, data.token); }
      state.loginOpen = false; state.authMessage = "";
      // 登录前接口不返回 SOP 内容(planLocked)，登录后重新拉取当前页数据
      if (state.projectView === "album" && state.currentProject) { renderProjectAlbum(state.currentProject); }
      else if (state.projectView === "manager") { loadProjectManager(state.currentProject?.id); }
      else if (state.projectView === "preview" && state.currentProject) { renderProjectPreview(state.currentProject, state.projectPreviewIndex, state.projectPreviewMode); }
      else if (state.projectView === "hub") { loadProjectsView(); }
      else if (state.caseView) { loadCases(); }
      else if (state.currentActivity) { loadDetail(state.currentActivity.id); }
      else { loadList(); }
    } catch (err) { state.authMessage = err.message; state.authOk = false; rerenderCurrent(); }
  });
  // ---- 共创提交事件 ----
  document.querySelectorAll("[data-open-contribute]").forEach(btn =>
    btn.addEventListener("click", () => {
      state.contributeOpen = true; state.contributeMsg = ""; state.contributeOk = false;
      state.contributeStep = "basic"; state.contributeDraft = {};
      state.contributeImages = [];
      state.contributeRows = [{ time: "", item: "" }]; rerenderCurrent();
    }));
  document.querySelectorAll("[data-close-contribute]").forEach(btn =>
    btn.addEventListener("click", () => { state.contributeOpen = false; rerenderCurrent(); }));
  document.querySelectorAll("[data-c-step]").forEach(btn =>
    btn.addEventListener("click", () => { saveContributeForm(); state.contributeStep = btn.dataset.cStep; rerenderCurrent(); }));
  document.querySelectorAll("[data-c-nav]").forEach(btn =>
    btn.addEventListener("click", () => {
      const steps = ["basic", "content", "sop", "media"];
      const i = steps.indexOf(state.contributeStep) + Number(btn.dataset.cNav);
      if (i >= 0 && i < steps.length) { saveContributeForm(); state.contributeStep = steps[i]; rerenderCurrent(); }
    }));
  const addRowBtn = document.querySelector("#contributeAddRow");
  if (addRowBtn) addRowBtn.addEventListener("click", () => {
    syncContributeRows();
    state.contributeRows.push({ time: "", item: "" });
    const box = document.querySelector("#contributeRowsBox");
    if (box) { box.innerHTML = contributeRowsHtml(); bindContributeRows(); }
  });
  bindContributeRows();
  const imgInput = document.querySelector("#contributeImageInput");
  if (imgInput) imgInput.addEventListener("change", async e => {
    saveContributeForm();
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      try {
        const data = await uploadPublicImageFile(file);
        state.contributeImages.push(data.url);
      } catch (err) {
        state.contributeMsg = err.message; state.contributeOk = false;
      }
    }
    rerenderCurrent();
  });
  document.querySelectorAll("[data-img-del]").forEach(btn =>
    btn.addEventListener("click", () => {
      saveContributeForm();
      state.contributeImages.splice(Number(btn.dataset.imgDel), 1);
      rerenderCurrent();
    }));
  const contributeForm = document.querySelector("#contributeForm");
  if (contributeForm) contributeForm.addEventListener("submit", async e => {
    e.preventDefault();
    saveContributeForm();
    syncContributeRows();
    const d = state.contributeDraft || {};
    if (!String(d.title || "").trim()) {
      state.contributeOk = false; state.contributeMsg = "请填写活动标题";
      state.contributeStep = "basic"; rerenderCurrent(); return;
    }
    const splitLines = v => String(v || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const highlights = splitLines(d.highlights);
    const videos = splitLines(d.videos);
    const references = splitLines(d.references);
    const tags = String(d.tags || "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const schedule = state.contributeRows.filter(r => r.item.trim()).map(r => ({ time: r.time.trim(), item: r.item.trim() }));
    const plan = { target: d.target || "", materials: d.materials || "", staffing: d.staffing || "", conversion: d.conversion || "", risk: d.risk || "" };
    const images = state.contributeImages || [];
    const cover = (d.cover && d.cover.trim()) ? d.cover.trim() : (images[0] || "");
    try {
      const data = await api("/api/my-activities", { method: "POST", body: {
        title: d.title, intro: d.intro, city: d.city, region: d.region, category: d.category,
        activityType: d.activityType, price: d.price, capacity: d.capacity, duration: d.duration,
        location: d.location, contact: d.contact, cover: cover, downloadEnabled: d.downloadEnabled,
        highlights, videos, references, tags, schedule, plan, images
      }});
      state.contributeOk = true;
      state.contributeMsg = (data && data.message) || "已提交，等待总部审核通过后上线";
      state.contributeDraft = {}; state.contributeImages = []; state.contributeRows = [{ time: "", item: "" }]; state.contributeStep = "basic";
      rerenderCurrent();
    } catch (err) { state.contributeOk = false; state.contributeMsg = err.message; rerenderCurrent(); }
  });

  const registerForm = document.querySelector("#registerForm");
  if (registerForm) registerForm.addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const data = await api("/api/register", { method:"POST", body:{ username:f.get("username"), password:f.get("password"), name:f.get("name") } });
      state.authTab = "login";
      state.authOk = true;
      state.authMessage = (data && data.message) || "申请已提交，请等待管理员开通后登录";
      rerenderCurrent();
    } catch (err) { state.authMessage = err.message; state.authOk = false; rerenderCurrent(); }
  });
}

// ---- 活动列表 ----
function activityCard(a) {
  const isFav = state.favorites.has(a.id);
  const tags = (a.tags || []).slice(0, 3).map(t => `<span class="tag-pill">${esc(t)}</span>`).join("");
  return `
    <article class="activity-card" data-id="${esc(a.id)}">
      <div class="card-img">
        <img src="${esc(imageUrl(a.cover))}" alt="${esc(a.title)}" loading="lazy">
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
          <div class="card-footer-actions">
            <a class="card-cta" href="${activityHref(a.id)}">查看方案 →</a>
            <button class="card-cta card-share" type="button" data-share-activity="${esc(a.id)}">📤 分享</button>
          </div>
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

async function loadHomeCases() {
  if (state.homeCasesLoaded) return;
  state.homeCasesLoaded = true;
  try {
    const data = await api("/api/public/cases");
    state.homeCases = Array.isArray(data?.cases) ? data.cases : [];
  } catch {
    state.homeCases = [];
  }
}

function getHeroCaseSlides() {
  const list = Array.isArray(state.homeCases) ? state.homeCases : [];
  const toTimeMs = (c) => {
    const candidates = [c.updatedAt, c.createdAt, c.dateLabel, c.date];
    for (const t of candidates) {
      if (typeof t === "number" && Number.isFinite(t)) return t;
      if (typeof t === "string") {
        const n = Date.parse(t);
        if (Number.isFinite(n)) return n;
      }
    }
    return 0;
  };
  return list
    .filter(c => c && (c.cover || (Array.isArray(c.media) && c.media.length)))
    .map(c => {
      const s = caseMediaSummary(c);
      const cover = c.cover || (s.imgs.length ? s.imgs[0].url : null);
      if (!cover) return null;
      return {
        createdAtMs: toTimeMs(c),
        id: c.id,
        title: c.title || "精彩案例",
        meta: [c.city, c.category, c.dateLabel].filter(Boolean).join(" · "),
        cover,
        mediaCount: Array.isArray(c.media) ? c.media.length : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, HERO_CASE_LIMIT);
}

function heroCaseSlidesHtml() {
  const list = getHeroCaseSlides();
  if (!list.length) {
    return `
      <a class="hero-case-empty" href="${SILVER_FRONT_BASE}/?view=cases">
        <div class="hero-case-empty-title">精彩案例</div>
        <p>暂无可用展示素材，点击查看全部案例</p>
      </a>`;
  }
  const dots = list.length >= 2
    ? `<div class="hero-case-dots">${list.map((_, i) => `<span class="hero-case-dot ${i === 0 ? "active" : ""}" data-case-dot="${i}"></span>`).join("")}</div>`
    : "";
  return `
    <div class="hero-case-panel">
      <div class="hero-case-head">
        <div>
          <div class="hero-case-kicker">精彩案例</div>
          <div class="hero-case-title">真实执行案例</div>
        </div>
        <a class="hero-case-entry" href="${SILVER_FRONT_BASE}/?view=cases">查看全部 →</a>
      </div>
      <div class="hero-case-slider">
        ${list.map((c, idx) => `
          <a href="${caseHref(c.id)}" class="hero-case-item ${idx === 0 ? "active" : ""}" data-case-item="${idx}">
            <img class="hero-case-cover" src="${esc(c.cover)}" alt="${esc(c.title)}">
            <div class="hero-case-info">
              <strong>${esc(c.title)}</strong>
              <span>${esc(c.meta || "精彩活动实录")}</span>
              <em>${esc(String(c.mediaCount || 0))} 个素材</em>
            </div>
          </a>`).join("")}
        ${dots}
      </div>
    </div>`;
}

function renderList() {
  state.currentActivity = null;
  const groups = groupActivities(state.activities);
  const quickGroups = groups;
  const first = state.activities[0];

  app.className = "app-shell";
  app.innerHTML = `
    <header class="site-header">
      <a class="brand-mark" href="${homeHref()}">
        <div class="brand-icon"></div>
        <span>开开华彩</span>
      </a>
      <nav>
        <a href="#quick-entry">分类入口</a>
        <a href="#activity-list">活动库</a>
        <a href="?view=cases">精彩案例</a>
        ${state.user ? `<a href="?view=projects">我的活动</a>` : ""}
        ${state.user?.role === "admin" ? `<a href="${adminHref()}">管理后台</a>` : ""}
        ${state.user ? `<a class="contribute-entry" data-open-contribute>+ 我要共创</a>` : ""}
        <div class="auth-actions">${authBar()}</div>
      </nav>
      ${mobilePrimaryNav("activities")}
    </header>

    <!-- Hero -->
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">
          <span class="eyebrow-dot"></span>
          全国同城主理人 · 活动 SOP 学习平台
        </div>
        <h1>${(state.siteConfig.heroTitle && state.siteConfig.heroTitle.trim())
          ? esc(state.siteConfig.heroTitle).replace(/\n/g, "<br>")
          : '让每座城市的<br><em>银发社群</em>都能<br>办出好活动'}</h1>
        <p>${state.siteConfig.heroDesc || '精选 '+state.activities.length+' 套活动方案，包含完整执行流程、物料清单、价格参考、风险预案，主理人学习即可落地执行。'}</p>
        ${state.user
          ? (state.user.role === "admin" ? `<div style="display:flex;gap:10px;flex-wrap:wrap;"><a class="btn" href="${adminHref()}">进入后台</a></div>` : "")
          : `<div style="display:flex;gap:10px;flex-wrap:wrap;"><button class="btn" type="button" data-open-login>登录学习</button></div>`}
        <div class="hero-stats">
          <div class="hero-stat"><strong>${state.activities.length}+</strong><span>活动方案</span></div>
          <div class="hero-stat"><strong>${groups.length}</strong><span>活动大类</span></div>
          <div class="hero-stat"><strong>${state.cities.length || "全国"}+</strong><span>覆盖城市</span></div>
        </div>
      </div>
        <div class="hero-visual">
          ${heroCaseSlidesHtml()}
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

    ${loginModal()}${contributeModal()}`;

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

  document.querySelectorAll("[data-share-activity]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      await shareLink({
        url: activityShareHref(btn.dataset.shareActivity),
        title: "分享活动方案",
        text: "开开华彩活动 SOP · 活动方案",
        button: btn
      });
    });
  });

  bindAuthEvents();
  setTimeout(() => startHeroCaseCarousel(), 100);
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
        ${panelTitle("当日活动时间轴")}
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
      <div class="sop-card-body">${esc(content)}</div>
    </div>` : "";

  const downloadHtml = !state.user
    ? `<div class="download-info"><h4>导出可视化 SOP</h4><p>登录账号后即可导出可视化执行包，内容浏览无需登录。</p></div>
       <button class="btn" type="button" data-open-login>登录导出</button>`
    : a.downloadEnabled === false
    ? `<div class="download-info"><h4>导出可视化 SOP</h4><p>该活动暂未开放 SOP 导出，请联系总部开通。</p></div>
       <button class="btn secondary" disabled>暂未开放导出</button>`
    : `<div class="download-info"><h4>导出可视化 SOP</h4><p>包含活动定位、当日时间轴、沟通话术、所需物料、人员分工和复盘清单，可直接打印或另存 PDF。</p></div>
       <div style="display:flex;gap:10px;flex-wrap:wrap;">
         <button class="btn" type="button" id="downloadSopBtn">⬇ 导出 SOP</button>
         <span id="downloadTip" style="font-size:13px;color:var(--muted);align-self:center;"></span>
       </div>`;

  const planHtml = (!state.user && a.planLocked)
    ? `<div class="sop-locked">
        <div class="sop-grid sop-blur" aria-hidden="true">
          ${[["活动定位","🎯"],["所需物料","📦"],["人员分工","👥"],["话术与转化承接","🔄"],["注意事项与风险预案","⚠️"]].map(([t,icon]) => `
          <div class="sop-card">
            <div class="sop-card-title">${icon} ${t}</div>
            <div class="sop-card-body">本模块包含完整的执行细节、话术模板与落地检查项，注册登录后即可查看全部内容。</div>
          </div>`).join("")}
        </div>
        <div class="sop-locked-overlay">
          <div class="sop-locked-box">
            <div class="sop-locked-icon">🔒</div>
            <h4>完整执行方案需登录查看</h4>
            <p>登录或申请注册账号后，即可查看活动定位、所需物料、人员分工、话术承接、注意事项与风险预案等完整 SOP。</p>
            <div class="sop-locked-btns">
              <button class="btn" type="button" data-open-login>登录查看</button>
              <button class="btn secondary" type="button" data-open-register>申请注册</button>
            </div>
          </div>
        </div>
      </div>`
    : `<div class="sop-grid">
      ${planCard("活动定位", "🎯", plan.target)}
      ${planCard("所需物料", "📦", plan.materials)}
      ${planCard("人员分工", "👥", plan.staffing)}
      ${planCard("话术与转化承接", "🔄", plan.conversion)}
      ${planCard("注意事项与风险预案", "⚠️", plan.risk)}
    </div>`;

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
    ${planHtml}
    <div class="download-section">${downloadHtml}</div>`;
}

// Tab 3: 参考素材
function tabMedia(a) {
  const images = a.images?.length ? a.images : [a.cover].filter(Boolean);
  const galleryImgs = images.map((src, i) =>
    `<div class="activity-media-tile ${i === 0 ? "img-main" : ""}" data-activity-media-key="image:${i}">
      <img src="${esc(src)}" alt="${esc(a.title)}" loading="lazy">
      <button class="media-share-btn" type="button" data-share-activity-media="image:${i}">📤 分享</button>
    </div>`).join("");

  const videoLinks = (Array.isArray(a.videos) ? a.videos.filter(Boolean) : []);
  const refLinks = (Array.isArray(a.references) ? a.references.filter(Boolean) : []);

  const linkItem = (url, index, label, mediaType) =>
    `<div class="resource-link-row" data-activity-media-key="${esc(mediaType)}:${index}">
      <a class="resource-link" href="${esc(url)}" target="_blank" rel="noreferrer">
        <span class="link-icon">🔗</span>${esc(label)} ${index+1}
      </a>
      <button class="btn secondary small media-share-btn" type="button" data-share-activity-media="${esc(mediaType)}:${index}">📤 分享</button>
    </div>`;

  return `
    <div class="gallery-grid">${galleryImgs || `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--muted)">暂无活动图片</div>`}</div>
    <div class="resource-row">
      <div class="resource-box">
        <h4>📹 视频参考</h4>
        ${videoLinks.length
          ? videoLinks.map((u,i) => linkItem(u, i, "视频参考", "video")).join("")
          : `<p style="font-size:13px;color:var(--hint);">暂无视频参考，主理人可在后台添加。</p>`}
      </div>
      <div class="resource-box">
        <h4>📄 方案参考</h4>
        ${refLinks.length
          ? refLinks.map((u,i) => linkItem(u, i, "方案参考", "reference")).join("")
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
      <a class="btn secondary" href="${homeHref()}">← 返回活动库</a>
      <div class="auth-actions">${authBar()}</div>
    </nav>

    <!-- 大图 Hero -->
    <div class="detail-hero" style="margin-top:20px">
      <img class="detail-cover-full"
           src="${esc(imageUrl(a.cover || (a.images && a.images[0])))}"
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
        <button class="btn light" id="shareActivityBtn">📤 分享活动</button>
        ${canDownload() && a.downloadEnabled !== false
          ? `<button class="btn" id="downloadSopBtn">⬇ 导出 SOP</button>`
          : a.downloadEnabled === false
          ? `<button class="btn light" disabled>暂未开放下载</button>`
          : `<button class="btn" type="button" data-open-login>登录下载</button>`}
      </div>
    </div>

    ${loginModal()}${contributeModal()}`;

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

  const shareActivityBtn = document.querySelector("#shareActivityBtn");
  if (shareActivityBtn) {
    shareActivityBtn.addEventListener("click", () => {
      const selected = state.selectedActivityMedia;
      return shareLink({
        url: activityShareHref(a.id, selected?.type, selected?.index),
        title: a.title || "分享活动方案",
        text: `${a.title || "活动方案"} · 开开华彩活动 SOP`,
        button: shareActivityBtn
      });
    });
  }

  document.querySelectorAll("[data-share-activity-media]").forEach(btn => {
    btn.addEventListener("click", () => {
      const [mediaType, rawIndex] = String(btn.dataset.shareActivityMedia || "").split(":");
      return shareLink({
        url: activityShareHref(a.id, mediaType, Number(rawIndex)),
        title: `${a.title || "活动方案"} · 分享素材`,
        text: `${a.title || "活动方案"} · 开开华彩活动 SOP 素材`,
        button: btn
      });
    });
  });

  const selectedMedia = state.selectedActivityMedia;
  if (selectedMedia) {
    const selectedNode = [...document.querySelectorAll("[data-activity-media-key]")]
      .find(node => node.dataset.activityMediaKey === `${selectedMedia.type}:${selectedMedia.index}`);
    selectedNode?.classList.add("share-target");
    selectedNode?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // 导出 SOP
  document.querySelectorAll("#downloadSopBtn").forEach(dlBtn => {
  dlBtn.addEventListener("click", async () => {
    try {
      dlBtn.textContent = "生成中…";
      const res = await fetch(apiUrl(`/api/public/activities/${encodeURIComponent(a.id)}/download`), { credentials:"include" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "导出失败"); }
      const html = await res.text();
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) {
        const link = document.createElement("a");
        link.href = url;
        link.download = `sop-${a.id || "activity"}.html`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      dlBtn.textContent = "✓ 已生成";
      setTimeout(() => dlBtn.textContent = "⬇ 导出 SOP", 2000);
    } catch (err) {
      alert(err.message);
      dlBtn.textContent = "⬇ 导出 SOP";
    }
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
    fileInput.addEventListener("change", async () => {
      const files = [...fileInput.files].slice(0, 3 - pendingImgs.length);
      upBtn.textContent = "上传中...";
      for (const f of files) {
        try {
          const data = await uploadPublicImageFile(f);
          pendingImgs.push(data.url);
          upBtn.textContent = "📎 已选 " + pendingImgs.length + " 张";
        } catch (err) {
          alert(err.message || "图片上传失败");
        }
      }
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
      const r = await fetch(apiUrl("/api/posts?activityId=" + encodeURIComponent(a.id)), { credentials:"include" }).then(x => x.json());
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
  const [data] = await Promise.all([
    api(`/api/public/activities?${p}`),
    loadHomeCases()
  ]);
  state.activities = data.activities || [];
  state.cities = data.cities || [];
  state.categories = data.categories || [];
  renderList();
}

async function loadDetail(id) {
  const data = await api(`/api/public/activities/${encodeURIComponent(id)}`);
  state.selectedActivityMedia = parseActivityMediaSelection();
  state.activeTab = state.selectedActivityMedia ? "media" : "intro";
  const isNewActivityView = state.currentActivity?.id !== data.activity?.id;
  renderDetail(data.activity);
  if (isNewActivityView && data.activity?.id) void trackMediaView("activity", data.activity.id, null);
}

function projectMediaLabel(type) {
  return type === "image" ? "图片" : type === "video" ? "视频" : "素材";
}

// 上传时 title 保存的是浏览器选择器返回的原文件名；展示层统一从这里取名，
// 不使用 TOS 内部对象名，避免把随机存储键暴露给客户。
function projectMediaDisplayName(media, index = media?.index) {
  const title = String(media?.title || media?.name || "").trim();
  if (title) return title;
  const number = Number.isInteger(Number(index)) ? ` #${Number(index) + 1}` : "";
  return `未命名${projectMediaLabel(media?.type)}${number}`;
}

function projectMediaTypeForTab(tab) {
  return tab === "images" ? "image" : tab === "videos" ? "video" : "";
}

function projectMediaGroups(project) {
  const groups = { images: [], videos: [] };
  (project?.media || []).forEach((m, index) => {
    const item = { ...m, index };
    if (m.type === "image") groups.images.push(item);
    else if (m.type === "video") groups.videos.push(item);
  });
  return groups;
}

function projectDefaultMediaTab(project) {
  const groups = projectMediaGroups(project);
  return groups.images.length ? "images" : "videos";
}

function projectMediaFileType(file) {
  const name = String(file?.name || "").toLowerCase();
  const ext = name.includes(".") ? "." + name.split(".").pop() : "";
  if (file?.type?.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return "image";
  if (file?.type?.startsWith("video/") || [".mp4", ".m4v", ".mov", ".webm"].includes(ext)) return "video";
  return "";
}

function projectMediaAuditCount(project, mediaIndex, action) {
  return Number((project?.auditSummary || [])
    .find(x => Number(x.mediaIndex) === Number(mediaIndex) && x.action === action)?.count || 0);
}

function projectAuditTotal(project, action) {
  return (project?.auditSummary || [])
    .filter(x => x.action === action)
    .reduce((sum, x) => sum + Number(x.count || 0), 0);
}

const PROJECT_VIDEO_MULTIPART_THRESHOLD = 16 * 1024 * 1024;
const PROJECT_VIDEO_PART_RETRIES = 4;
const PROJECT_VIDEO_UPLOAD_WORKERS = 3;
const PROJECT_VIDEO_PART_TIMEOUT_MS = 180000;
const PROJECT_VIDEO_UPLOAD_STATE_PREFIX = "silver_project_video_upload:";

function projectUploadSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function projectUploadStateKey(projectId, file) {
  return `${PROJECT_VIDEO_UPLOAD_STATE_PREFIX}${projectId}:${file.name || "video"}:${file.size || 0}:${file.lastModified || 0}`;
}

function readProjectUploadState(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function writeProjectUploadState(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function clearProjectUploadState(key) {
  try { localStorage.removeItem(key); } catch {}
}

async function projectFetchWithTimeout(url, options, timeoutMs = PROJECT_VIDEO_PART_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function uploadProjectVideoMultipart(projectId, file, onProgress) {
  const name = String(file.name || "video.mp4");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "mp4";
  const storageKey = projectUploadStateKey(projectId, file);
  const saved = readProjectUploadState(storageKey);
  let init = null;
  let sessionId = saved?.sessionId || "";
  if (sessionId) {
    try {
      const status = await api(`/api/my/activity-projects/${encodeURIComponent(projectId)}/media/upload-session/${encodeURIComponent(sessionId)}/status`);
      if (status.status === "completed") {
        const completed = await api(`/api/my/activity-projects/${encodeURIComponent(projectId)}/media/upload-session/${encodeURIComponent(sessionId)}/complete`, { method: "POST", body: {} });
        clearProjectUploadState(storageKey);
        return completed;
      }
      if (status.status === "uploading" && Number(status.fileSize) === Number(file.size) && String(status.filename || "").toLowerCase().endsWith(`.${ext}`)) {
        init = status;
      } else {
        clearProjectUploadState(storageKey);
        sessionId = "";
      }
    } catch {
      clearProjectUploadState(storageKey);
      sessionId = "";
    }
  }
  if (!init) {
    init = await api(`/api/my/activity-projects/${encodeURIComponent(projectId)}/media/init`, {
      method: "POST",
      body: { type: "video", ext, title: name, size: file.size }
    });
    sessionId = init.sessionId;
  }
  if (!sessionId || !init.partSize || !init.partCount) throw new Error("视频分片上传初始化失败");
  const completedParts = new Set((init.completedParts || []).map(Number).filter(part => Number.isInteger(part) && part >= 1 && part <= Number(init.partCount)));
  const persistState = () => writeProjectUploadState(storageKey, {
    sessionId,
    projectId,
    fileName: name,
    fileSize: file.size,
    lastModified: file.lastModified || 0,
    completedParts: Array.from(completedParts).sort((a, b) => a - b),
    updatedAt: Date.now()
  });
  persistState();
  const uploadedBytes = () => Array.from(completedParts).reduce((total, partNumber) => {
    const start = (partNumber - 1) * init.partSize;
    return total + Math.max(0, Math.min(file.size, start + init.partSize) - start);
  }, 0);
  if (onProgress) onProgress({ uploadedBytes: uploadedBytes(), totalBytes: file.size, percent: Math.round(uploadedBytes() / file.size * 100) });

  const uploadPart = async partNumber => {
    if (completedParts.has(partNumber)) return;
    const start = (partNumber - 1) * init.partSize;
    const end = Math.min(file.size, start + init.partSize);
    let lastError = null;
    for (let attempt = 1; attempt <= PROJECT_VIDEO_PART_RETRIES; attempt++) {
      try {
        const signed = await api(`/api/my/activity-projects/${encodeURIComponent(projectId)}/media/upload-session/${encodeURIComponent(sessionId)}/part-url?partNumber=${partNumber}`);
        const response = await projectFetchWithTimeout(signed.url, {
          method: "PUT",
          mode: "cors",
          headers: { "Content-Type": file.type || "video/mp4" },
          body: file.slice(start, end)
        });
        if (!response.ok) throw new Error(`第${partNumber}片上传失败（HTTP ${response.status}）`);
        completedParts.add(partNumber);
        persistState();
        if (onProgress) onProgress({ uploadedBytes: uploadedBytes(), totalBytes: file.size, percent: Math.round(uploadedBytes() / file.size * 100) });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < PROJECT_VIDEO_PART_RETRIES) await projectUploadSleep(Math.min(3000, attempt * 700));
      }
    }
    throw lastError || new Error(`第${partNumber}片上传失败`);
  };

  const pending = [];
  for (let partNumber = 1; partNumber <= init.partCount; partNumber++) {
    if (!completedParts.has(partNumber)) pending.push(partNumber);
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const partNumber = pending[cursor++];
      await uploadPart(partNumber);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PROJECT_VIDEO_UPLOAD_WORKERS, Math.max(1, pending.length)) }, () => worker()));
    const result = await api(`/api/my/activity-projects/${encodeURIComponent(projectId)}/media/upload-session/${encodeURIComponent(sessionId)}/complete`, { method: "POST", body: {} });
    clearProjectUploadState(storageKey);
    return result;
  } catch (error) {
    persistState();
    throw error;
  }
}

async function uploadProjectMediaFile(projectId, file, onProgress) {
  const type = projectMediaFileType(file);
  if (!type) throw new Error("活动相册仅支持图片和视频");
  const name = String(file.name || "file");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "bin";
  if (type === "video" && Number(file.size || 0) >= PROJECT_VIDEO_MULTIPART_THRESHOLD) {
    return uploadProjectVideoMultipart(projectId, file, onProgress);
  }
  const query = new URLSearchParams({ type, ext, title: name });
  const headers = { "Content-Type": file.type || "application/octet-stream" };
  if (state.sessionToken) headers.Authorization = `Bearer ${state.sessionToken}`;
  const res = await fetch(apiUrl(`/api/my/activity-projects/${encodeURIComponent(projectId)}/media?${query}`), {
    method: "POST",
    credentials: "include",
    headers,
    body: file
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "素材上传失败");
  return data;
}

function projectShareButton(project, mediaIndex, className = "btn secondary small") {
  return `<button class="${className}" type="button" data-project-share="${esc(project.id)}" ${mediaIndex === undefined ? "" : `data-project-media-share="${mediaIndex}"`}>📤 分享</button>`;
}

function projectDownloadButton(project, index) {
  const type = project.media[index]?.type;
  if (type === "image" && isMobileProjectDownload()) {
    return "";
  }
  const name = projectMediaDisplayName(project.media[index], index);
  if (!state.user) {
    return `<button class="btn secondary small" type="button" data-project-login title="登录后下载${esc(name)}">登录后下载</button>`;
  }
  return `<button class="btn small" type="button" data-project-download="${index}" title="下载${esc(name)}">下载${projectMediaLabel(type)}</button>`;
}

function projectMobileMediaTip(project, index) {
  const type = project.media[index]?.type;
  if (!isMobileProjectDownload() || !["image", "video"].includes(type)) return "";
  const target = type === "video" ? "点视频右下角⋮，选择下载" : "长按图片，点击下载到相册";
  return `<p class="project-mobile-media-tip">特别提醒：${target}</p>`;
}

function isMobileProjectDownload() {
  return /Android|HarmonyOS|Adr|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
    || Boolean(window.matchMedia?.("(max-width: 760px)").matches);
}

function bindProjectVideoThumbs() {
  document.querySelectorAll("video[data-project-video-thumb]").forEach(video => {
    const seekToThumb = () => {
      if (video.dataset.thumbReady === "1" || !Number.isFinite(video.duration) || video.duration <= 0) return;
      try {
        video.currentTime = Math.min(0.5, Math.max(0, video.duration - 0.05));
        video.dataset.thumbReady = "1";
      } catch {}
    };
    video.addEventListener("loadedmetadata", seekToThumb, { once: true });
    if (video.readyState >= 1) seekToThumb();
  });
}

function triggerProjectDownload(url, filename = "活动素材", type = "") {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  // 移动端新窗口容易被微信/系统浏览器当作媒体预览，直接在当前上下文访问
  // 带 attachment 的 TOS 地址，交给浏览器自己的下载流程处理。
  link.target = isMobileProjectDownload() && type !== "video" ? "_self" : "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function projectMediaCardHtml(project, m, manager = false) {
  if (!["image", "video"].includes(m.type)) return "";
  const mediaName = projectMediaDisplayName(m, m.index);
  if (!manager) {
    const visual = m.type === "image"
      ? `<img src="${esc(m.url)}" alt="${esc(project.title)}" loading="lazy">`
      : m.type === "video"
      ? `<video src="${esc(m.url)}#t=0.5" data-project-video-thumb muted playsinline preload="metadata"></video><span class="project-gallery-play">▶</span>`
      : "";
    return `<button class="project-gallery-tile" type="button" data-project-open-media="${m.index}" aria-label="打开${projectMediaLabel(m.type)}：${esc(mediaName)}">
      ${visual}<span class="project-gallery-name" title="${esc(mediaName)}">${esc(mediaName)}</span><span class="project-gallery-badge">${projectMediaLabel(m.type)}</span>
    </button>`;
  }
  const selected = state.selectedProjectMediaIndex === m.index ? "share-target" : "";
  const visual = m.type === "image"
    ? `<img src="${esc(m.url)}" alt="${esc(project.title)}" loading="lazy">`
    : m.type === "video"
    ? `<button class="project-media-video-preview" type="button" data-project-open-media="${m.index}" aria-label="打开视频 ${m.index + 1}"><video src="${esc(m.url)}#t=0.5" data-project-video-thumb muted playsinline preload="metadata"></video><span class="project-gallery-play">▶</span></button>`
    : "";
  return `<article class="project-media-card ${selected}" data-project-media-index="${m.index}">
    <div class="project-media-visual">${visual}</div>
    <div class="project-media-info">
      <div class="project-media-head"><strong>${esc(projectMediaLabel(m.type))}</strong><span>#${m.index + 1}</span></div>
      <p class="project-media-filename" title="${esc(mediaName)}">${esc(mediaName)}</p>
      ${m.caption ? `<p class="project-media-caption">备注：${esc(m.caption)}</p>` : ""}
      ${manager ? `<div class="project-media-audit-counts"><span>查看 ${projectMediaAuditCount(project, m.index, "view")}</span><span>下载 ${projectMediaAuditCount(project, m.index, "download")}</span></div>` : ""}
      <div class="project-media-actions">
        ${projectShareButton(project, m.index)}
        ${projectDownloadButton(project, m.index)}
        ${manager ? `<button class="btn ghost small danger" type="button" data-project-delete-media="${m.index}">删除</button>` : ""}
      </div>
    </div>
  </article>`;
}

function projectLightboxHtml(project) {
  const index = state.projectLightboxIndex === null || state.projectLightboxIndex === undefined || state.projectLightboxIndex === ""
    ? -1
    : Number(state.projectLightboxIndex);
  const media = Array.isArray(project.media) ? project.media : [];
  if (!Number.isInteger(index) || index < 0 || index >= media.length) return "";
  const m = media[index];
  const mediaName = projectMediaDisplayName(m, index);
  const body = m.type === "image"
    ? `<img class="project-lightbox-image" src="${esc(m.url)}" alt="${esc(m.title || project.title)}">`
    : m.type === "video"
    ? `<video class="project-lightbox-video" src="${esc(m.url)}" controls playsinline preload="metadata"></video>`
    : `<div class="project-lightbox-document"><strong>文档素材</strong><span>${esc(m.title || "活动交付文档")}</span><a class="btn small" href="${esc(m.url)}" target="_blank" rel="noreferrer">打开文档</a></div>`;
  return `<div class="project-lightbox" role="dialog" aria-modal="true" aria-label="查看活动素材">
    <button class="project-lightbox-close" type="button" data-project-lightbox-close aria-label="关闭">×</button>
    ${index > 0 ? `<button class="project-lightbox-nav prev" type="button" data-project-lightbox-nav="${index - 1}" aria-label="上一个">‹</button>` : ""}
    <div class="project-lightbox-stage">${body}</div>
    ${index < media.length - 1 ? `<button class="project-lightbox-nav next" type="button" data-project-lightbox-nav="${index + 1}" aria-label="下一个">›</button>` : ""}
    <div class="project-lightbox-toolbar">
      <span>${index + 1} / ${media.length}</span>
      ${projectShareButton(project, index, "btn secondary small")}
      ${projectDownloadButton(project, index)}
    </div>
    ${projectMobileMediaTip(project, index)}
    <p class="project-lightbox-caption"><strong>${esc(mediaName)}</strong>${m.caption ? `<span>备注：${esc(m.caption)}</span>` : ""}</p>
  </div>`;
}

function projectHeader(title, subtitle = "") {
  return `<header class="site-header">
    <a class="brand-mark" href="${homeHref()}"><div class="brand-icon"></div><span>开开华彩</span></a>
    <nav><a href="${homeHref()}">活动库</a><a href="?view=cases">精彩案例</a>${state.user ? `<a href="?view=projects">我的活动</a>` : ""}<div class="auth-actions">${authBar()}</div></nav>
    ${mobilePrimaryNav("projects")}
  </header>`;
}

function renderProjectLogin() {
  state.projectView = "hub";
  state.projectCreateOpen = false;
  state.currentActivity = null;
  app.className = "app-shell";
  app.innerHTML = `${projectHeader("活动交付相册")}
    <section class="project-login-empty"><div class="project-empty-icon">▣</div><h1>活动交付相册</h1><p>登录后创建活动相册，把照片和视频直接交付给客户。</p><button class="btn" type="button" data-open-login>登录后开始</button></section>${loginModal()}`;
  bindAuthEvents();
}

async function loadProjectsView() {
  state.projectView = "hub";
  state.caseView = false;
  state.currentActivity = null;
  if (!state.user) return renderProjectLogin();
  if (!state.activities.length) {
    try {
      const activities = await api("/api/public/activities");
      state.activities = activities.activities || [];
    } catch {}
  }
  try {
    const data = await api("/api/my/activity-projects");
    state.projects = data.projects || [];
    renderProjectsView();
  } catch (err) {
    app.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

function renderProjectsView() {
  state.projectView = "hub";
  state.currentActivity = null;
  state.projectMetaEditOpen = false;
  const projects = state.projects || [];
  app.className = `app-shell${isMobileProjectDownload() ? " project-mobile-mode" : ""}`;
  app.innerHTML = `${projectHeader("我的活动")}
    <section class="project-hub-head">
      <div><div class="eyebrow"><span class="eyebrow-dot"></span>活动交付工作台</div><h1>我的活动相册</h1><p>每场活动单独建一个相册，上传现场照片和视频后直接发给客户。</p></div>
      <button class="btn" id="openProjectCreateBtn" type="button">＋ 新建活动项目</button>
    </section>
    <section class="project-list-section"><div class="section-label"><div class="label-bar"></div><div><h2>活动项目</h2><p>${projects.length ? `已创建 ${projects.length} 场活动` : "还没有活动项目"}</p></div></div>
      ${projects.length ? `<div class="project-list-grid">${projects.map(p => {
        const g = projectMediaGroups(p);
        return `<article class="project-list-card"><div class="project-list-cover">${p.cover ? `<img src="${esc(p.cover)}" alt="${esc(p.title)}">` : `<div class="project-cover-empty">▣</div>`}<span>${p.status === "published" ? "可分享" : "已归档"}</span></div><div class="project-list-body"><h3>${esc(p.title)}</h3><p>${esc([p.city, p.dateLabel].filter(Boolean).join(" · ") || "未填写时间地点")}</p><div class="project-list-stats">${g.images.length} 图片 · ${g.videos.length} 视频</div><div class="project-list-actions"><button class="btn small" type="button" data-project-open="${esc(p.id)}">管理素材</button>${p.status === "published" ? `<a class="btn secondary small" href="${esc(projectShareHref(p.id))}" target="_blank" rel="noreferrer">打开客户相册</a>${projectShareButton(p)}` : ""}</div></div></article>`;
      }).join("")}</div>` : `<div class="project-empty-state">创建第一场活动，把微信群里的素材迁移到平台。</div>`}
    </section>${state.projectCreateOpen ? `<div class="project-create-modal-mask" data-project-create-overlay><section class="project-create-modal" role="dialog" aria-modal="true" aria-labelledby="projectCreateTitle"><button class="project-create-close" type="button" data-close-project-create aria-label="关闭">×</button><div class="eyebrow"><span class="eyebrow-dot"></span>新建活动项目</div><h2 id="projectCreateTitle">创建活动相册</h2><p>先填写活动信息，创建后进入相册页面上传照片和视频。</p><form id="projectCreateForm" class="project-create-form"><label><span>活动名称</span><input class="input" name="title" required placeholder="例如：8月9日山西社群旗袍美拍"></label><label><span>关联 SOP</span><select class="select" name="activityId"><option value="">暂不关联</option>${(state.activities || []).map(a => `<option value="${esc(a.id)}">${esc(a.title)}</option>`).join("")}</select></label><label><span>活动日期</span><input class="input" name="dateLabel" type="date"></label><label><span>城市/地区</span><input class="input" name="city" placeholder="例如：太原"></label><label class="project-create-wide"><span>给客户看的活动说明</span><textarea class="input" name="description" rows="3" placeholder="活动回顾、感谢语或交付提示"></textarea></label><div class="project-create-modal-actions"><button class="btn secondary" type="button" data-close-project-create>取消</button><button class="btn" type="submit">创建并进入上传</button></div></form></section></div>` : ""}${loginModal()}`;

  document.querySelector("#openProjectCreateBtn")?.addEventListener("click", () => { state.projectCreateOpen = true; renderProjectsView(); });
  document.querySelectorAll("[data-close-project-create]").forEach(btn => btn.addEventListener("click", () => { state.projectCreateOpen = false; renderProjectsView(); }));
  document.querySelector("[data-project-create-overlay]")?.addEventListener("click", e => { if (e.target.dataset.projectCreateOverlay !== undefined) { state.projectCreateOpen = false; renderProjectsView(); } });
  document.querySelector("#projectCreateForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const btn = e.currentTarget.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "创建中…";
    try {
      const data = await api("/api/my/activity-projects", { method: "POST", body: { title: f.get("title"), activityId: f.get("activityId"), dateLabel: f.get("dateLabel"), city: f.get("city"), description: f.get("description") } });
      state.projectCreateOpen = false;
      history.pushState(null, "", `?view=project-manage&project=${encodeURIComponent(data.project.id)}`);
      await loadProjectManager(data.project.id);
    } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "创建并上传素材"; }
  });
  document.querySelectorAll("[data-project-open]").forEach(btn => btn.addEventListener("click", () => {
    state.projectCreateOpen = false;
    history.pushState(null, "", `?view=project-manage&project=${encodeURIComponent(btn.dataset.projectOpen)}`);
    loadProjectManager(btn.dataset.projectOpen);
  }));
  bindProjectShareEvents();
  bindAuthEvents();
}

function bindProjectShareEvents() {
  document.querySelectorAll("[data-project-share]").forEach(btn => btn.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const index = btn.dataset.projectMediaShare;
    return shareLink({ url: projectShareHref(btn.dataset.projectShare, index === undefined ? undefined : Number(index)), title: "分享活动相册", text: "开开华彩活动交付相册", button: btn });
  }));
}

async function loadProjectManager(id) {
  if (!state.user) return renderProjectLogin();
  if (!id) return loadProjectsView();
  try {
    const data = await api(`/api/my/activity-projects/${encodeURIComponent(id)}`);
    state.currentProject = data.project;
    state.projectView = "manager";
    renderProjectManager(state.currentProject);
  } catch (err) { app.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
}

function renderProjectManager(project) {
  state.projectView = "manager";
  state.currentProject = project;
  state.currentActivity = null;
  const g = projectMediaGroups(project);
  if (!["images", "videos"].includes(state.projectMediaTab)) state.projectMediaTab = g.images.length ? "images" : "videos";
  const managerTab = state.projectMediaTab;
  const managerType = projectMediaTypeForTab(managerTab);
  const managerMedia = (project.media || []).map((m, i) => ({ ...m, index: i })).filter(m => !managerType || m.type === managerType);
  const activity = (state.activities || []).find(a => a.id === project.activityId);
  const mobileMode = isMobileProjectDownload();
  const metaFormHtml = `<form id="projectMetaForm"><label><span>活动名称</span><input class="input" name="title" value="${esc(project.title)}"></label><label><span>日期</span><input class="input" name="dateLabel" value="${esc(project.dateLabel)}"></label><label><span>城市/地区</span><input class="input" name="city" value="${esc(project.city)}"></label><label><span>客户说明</span><textarea class="input" name="description" rows="5">${esc(project.description)}</textarea></label><button class="btn small" type="submit">保存活动信息</button></form>`;
  const projectMetaSummary = `<div class="project-mobile-meta-summary"><div><span class="project-mobile-meta-label">活动信息</span><strong>${esc(project.title)}</strong><small>${esc([project.dateLabel, project.city].filter(Boolean).join(" · ") || "未填写时间地点")}</small></div><button class="btn secondary small" type="button" data-open-project-meta>编辑信息</button></div>`;
  const metaPanelHtml = mobileMode
    ? `<div class="project-meta-panel project-meta-panel-mobile">${projectMetaSummary}</div>`
    : `<div class="project-meta-panel"><div class="panel-title"><span class="title-bar"></span>活动信息</div>${metaFormHtml}<div class="project-share-box"><strong>合作伙伴客户分享链接</strong><input class="input" readonly value="${esc(projectShareHref(project.id))}"><small>客户打开链接即可查看和下载本相册；精彩案例素材下载仍需登录或申请账号。</small></div>${state.user && ["admin", "operator"].includes(state.user.role) && !project.sourceCaseId ? `<button class="btn secondary project-promote-btn" id="projectPromoteBtn" type="button">沉淀为精彩案例草稿</button>` : project.sourceCaseId ? `<p class="project-promoted-note">已沉淀为案例：${esc(project.sourceCaseId)}</p>` : ""}</div>`;
  const metaModalHtml = mobileMode && state.projectMetaEditOpen
    ? `<div class="project-create-modal-mask project-meta-edit-mask" data-project-meta-overlay><section class="project-create-modal project-meta-edit-modal" role="dialog" aria-modal="true" aria-labelledby="projectMetaEditTitle"><button class="project-create-close" type="button" data-close-project-meta aria-label="关闭">×</button><div class="eyebrow"><span class="eyebrow-dot"></span>活动信息</div><h2 id="projectMetaEditTitle">编辑活动信息</h2><p>保存后返回素材上传界面。</p>${metaFormHtml}</section></div>`
    : "";
  app.className = `app-shell${mobileMode ? " project-mobile-mode" : ""}`;
  app.innerHTML = `${projectHeader(project.title)}
    <div class="project-manager-nav"><button class="btn secondary" id="projectBackBtn">← 返回我的活动</button><div>${projectShareButton(project)}<a class="btn secondary small" href="${projectShareHref(project.id)}" target="_blank" rel="noreferrer">打开客户相册</a></div></div>
    <section class="project-manager-head"><div><div class="eyebrow"><span class="eyebrow-dot"></span>活动交付相册</div><h1>${esc(project.title)}</h1><p>${esc(activity?.title ? `关联 SOP：${activity.title}` : "未关联标准 SOP")}</p></div><div class="project-manager-stats"><strong>${project.media?.length || 0}</strong><span>个素材</span><strong>${g.images.length}</strong><span>张图片</span><strong>${g.videos.length}</strong><span>个视频</span><strong>${projectAuditTotal(project, "view")}</strong><span>次查看</span><strong>${projectAuditTotal(project, "download")}</strong><span>次下载</span></div></section>
    <section class="project-manager-layout">
      ${metaPanelHtml}
      <div class="project-upload-panel"><div class="panel-title"><span class="title-bar"></span>现场素材 <span class="project-upload-hint">图片 ≤50MB · 视频 ≤2GB</span></div><label class="project-upload-zone" for="projectFileInput"><strong>＋ 选择照片或视频</strong><span>鸿蒙微信/部分安卓微信相册单次最多 9 张；上传完成后再次点击此处即可继续，不限总数</span><input id="projectFileInput" type="file" multiple accept="image/*,video/*"></label><div id="projectUploadProgress" class="project-upload-progress"></div><div class="project-album-tabs project-manager-media-tabs"><button class="${managerTab === "images" ? "active" : ""}" data-project-manager-tab="images">照片 <strong>${g.images.length}</strong></button><button class="${managerTab === "videos" ? "active" : ""}" data-project-manager-tab="videos">视频 <strong>${g.videos.length}</strong></button></div><div class="project-media-grid">${managerMedia.length ? managerMedia.map(m => projectMediaCardHtml(project, m, true)).join("") : `<div class="project-empty-state">该分类还没有素材。</div>`}</div></div>
    </section>${metaModalHtml}${projectLightboxHtml(project)}${loginModal()}`;

  document.querySelector("#projectBackBtn")?.addEventListener("click", () => { history.pushState(null, "", "?view=projects"); loadProjectsView(); });
  document.querySelector("[data-open-project-meta]")?.addEventListener("click", () => { state.projectMetaEditOpen = true; renderProjectManager(project); });
  document.querySelectorAll("[data-close-project-meta]").forEach(btn => btn.addEventListener("click", () => { state.projectMetaEditOpen = false; renderProjectManager(project); }));
  document.querySelector("[data-project-meta-overlay]")?.addEventListener("click", e => { if (e.target.dataset.projectMetaOverlay !== undefined) { state.projectMetaEditOpen = false; renderProjectManager(project); } });
  document.querySelector("#projectMetaForm")?.addEventListener("submit", async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const btn = e.currentTarget.querySelector("button"); btn.disabled = true; btn.textContent = "保存中…";
    try { const data = await api(`/api/my/activity-projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: { title: f.get("title"), dateLabel: f.get("dateLabel"), city: f.get("city"), description: f.get("description") } }); state.currentProject = data.project; state.projectMetaEditOpen = false; renderProjectManager(data.project); } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "保存活动信息"; }
  });
  document.querySelector("#projectFileInput")?.addEventListener("change", async e => {
    const files = [...e.target.files]; const progress = document.querySelector("#projectUploadProgress"); let done = 0;
    e.target.value = "";
    for (const file of files) {
      if (progress) progress.textContent = `正在上传本批 ${done + 1}/${files.length}：${file.name} · 已累计 ${state.currentProject?.media?.length || project.media?.length || 0} 个`;
      try {
        const data = await uploadProjectMediaFile(project.id, file, progressState => {
          if (progress) progress.textContent = `正在上传本批 ${done + 1}/${files.length}：${file.name} · ${progressState.percent}%`;
        });
        state.currentProject = data.project || state.currentProject;
        done++;
      }
      catch (err) { alert(`${file.name}：${err.message}`); }
    }
    if (progress) progress.textContent = done ? `本批完成 ${done}/${files.length} 个，可继续分批选择；当前共 ${state.currentProject?.media?.length || project.media?.length || 0} 个素材` : "";
    if (done) renderProjectManager(state.currentProject);
  });
  document.querySelectorAll("[data-project-manager-tab]").forEach(btn => btn.addEventListener("click", () => { state.projectMediaTab = btn.dataset.projectManagerTab; state.projectLightboxIndex = null; renderProjectManager(project); }));
  bindProjectVideoThumbs();
  document.querySelectorAll("[data-project-open-media]").forEach(btn => btn.addEventListener("click", () => navigateProjectPreview(project, Number(btn.dataset.projectOpenMedia), true)));
  document.querySelectorAll("[data-project-lightbox-close]").forEach(btn => btn.addEventListener("click", () => { state.projectLightboxIndex = null; renderProjectManager(project); }));
  document.querySelectorAll("[data-project-lightbox-nav]").forEach(btn => btn.addEventListener("click", () => { state.projectLightboxIndex = Number(btn.dataset.projectLightboxNav); renderProjectManager(project); }));
  document.querySelector(".project-lightbox")?.addEventListener("click", e => { if (e.target.classList.contains("project-lightbox")) { state.projectLightboxIndex = null; renderProjectManager(project); } });
  document.querySelectorAll("[data-project-download]").forEach(btn => btn.addEventListener("click", async () => { try { const data = await api(`/api/public/activity-projects/${encodeURIComponent(project.id)}/download?i=${btn.dataset.projectDownload}`); if (data.url) triggerProjectDownload(data.url, data.filename || `activity-${project.id}-${btn.dataset.projectDownload}`, project.media[Number(btn.dataset.projectDownload)]?.type); } catch (err) { alert(err.message); } }));
  document.querySelectorAll("[data-project-login]").forEach(btn => btn.addEventListener("click", () => { state.loginOpen = true; state.authMessage = ""; state.authTab = "login"; renderProjectManager(project); }));
  document.querySelectorAll("[data-project-delete-media]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("确定删除这个素材吗？TOS 文件会保留，但相册中不再展示。")) return;
    try { const data = await api(`/api/my/activity-projects/${encodeURIComponent(project.id)}/media/${btn.dataset.projectDeleteMedia}`, { method: "DELETE" }); state.currentProject = data.project; renderProjectManager(data.project); } catch (err) { alert(err.message); }
  }));
  document.querySelector("#projectPromoteBtn")?.addEventListener("click", async e => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "生成中…";
    try { const data = await api(`/api/my/activity-projects/${encodeURIComponent(project.id)}/promote-case`, { method: "POST" }); state.currentProject = data.project; alert(data.message || "已生成案例草稿"); renderProjectManager(data.project); } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "沉淀为精彩案例草稿"; }
  });
  bindProjectShareEvents();
  bindAuthEvents();
}

function navigateProjectPreview(project, index, manager = false) {
  state.projectLightboxIndex = null;
  state.projectPreviewMode = manager;
  history.pushState(null, "", projectPreviewHref(project.id, index, manager));
  loadProjectPreview(project.id, index, manager);
}

async function loadProjectPreview(id, index, manager = false) {
  const endpoint = manager
    ? `/api/my/activity-projects/${encodeURIComponent(id)}`
    : `/api/public/activity-projects/${encodeURIComponent(id)}`;
  try {
    const data = await api(endpoint);
    state.currentProject = data.project;
    renderProjectPreview(data.project, index, manager);
  } catch (err) {
    app.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

function renderProjectPreview(project, index, manager = false) {
  const media = Array.isArray(project.media) ? project.media : [];
  const currentIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
  const current = media[currentIndex];
  if (!current) {
    return manager ? loadProjectManager(project.id) : loadPublicProject(project.id);
  }
  state.projectView = "preview";
  state.currentProject = project;
  state.projectPreviewIndex = currentIndex;
  state.projectPreviewMode = manager;
  state.currentActivity = null;
  const currentName = projectMediaDisplayName(current, currentIndex);
  const body = current.type === "image"
    ? `<img class="project-preview-image" src="${esc(current.url)}" alt="${esc(current.title || project.title)}">`
    : current.type === "video"
    ? `<video class="project-preview-video" src="${esc(current.url)}" controls playsinline preload="metadata"></video>`
    : "";
  const backHref = manager
    ? `${SILVER_FRONT_BASE}/?view=project-manage&project=${encodeURIComponent(project.id)}`
    : `${SILVER_FRONT_BASE}/?view=project&project=${encodeURIComponent(project.id)}`;
  app.className = `app-shell project-preview-shell${isMobileProjectDownload() ? " project-mobile-mode" : ""}`;
  app.innerHTML = `${projectHeader(project.title)}
    <div class="project-preview-nav"><button class="btn secondary" id="projectPreviewBack" type="button">← 返回相册</button><a class="btn secondary" href="${esc(backHref)}">相册首页</a></div>${projectWeChatTip()}
    <main class="project-preview-page"><div class="eyebrow"><span class="eyebrow-dot"></span>${current.type === "video" ? "视频预览" : "图片预览"}</div><div class="project-preview-title-row"><div><h1>${esc(project.title)}</h1><p class="project-preview-media-name" title="${esc(currentName)}">${esc(currentName)}</p></div><span class="project-preview-count">${currentIndex + 1} / ${media.length}</span></div><div class="project-preview-stage">${body}</div>${projectMobileMediaTip(project, currentIndex)}<div class="project-preview-toolbar">${currentIndex > 0 ? `<button class="btn secondary small" type="button" data-project-preview-nav="${currentIndex - 1}">‹ 上一个</button>` : ""}${projectShareButton(project, currentIndex, "btn secondary small")}${projectDownloadButton(project, currentIndex)}${manager ? `<button class="btn ghost small danger" id="projectPreviewDelete" type="button">删除素材</button>` : ""}${currentIndex < media.length - 1 ? `<button class="btn secondary small" type="button" data-project-preview-nav="${currentIndex + 1}">下一个 ›</button>` : ""}</div>${current.caption ? `<p class="project-preview-caption">备注：${esc(current.caption)}</p>` : ""}</main>${loginModal()}`;

  const previewVideo = document.querySelector(".project-preview-video");
  if (previewVideo) {
    previewVideo.addEventListener("play", () => { void trackMediaView("activity_project_media", project.id, currentIndex); }, { once: true });
  } else if (current.type === "image") {
    void trackMediaView("activity_project_media", project.id, currentIndex);
  }

  document.querySelector("#projectPreviewBack")?.addEventListener("click", () => {
    history.pushState(null, "", backHref);
    manager ? loadProjectManager(project.id) : loadPublicProject(project.id);
  });
  document.querySelectorAll("[data-project-preview-nav]").forEach(btn => btn.addEventListener("click", () => {
    const nextIndex = Number(btn.dataset.projectPreviewNav);
    history.replaceState(null, "", projectPreviewHref(project.id, nextIndex, manager));
    loadProjectPreview(project.id, nextIndex, manager);
  }));
  document.querySelectorAll("[data-project-download]").forEach(btn => btn.addEventListener("click", async () => { try { const data = await api(`/api/public/activity-projects/${encodeURIComponent(project.id)}/download?i=${btn.dataset.projectDownload}`); if (data.url) triggerProjectDownload(data.url, data.filename || `activity-${project.id}-${btn.dataset.projectDownload}`, project.media[Number(btn.dataset.projectDownload)]?.type); } catch (err) { alert(err.message); } }));
  document.querySelectorAll("[data-project-login]").forEach(btn => btn.addEventListener("click", () => { state.loginOpen = true; state.authMessage = ""; state.authTab = "login"; renderProjectPreview(project, currentIndex, manager); }));
  document.querySelector("#projectPreviewDelete")?.addEventListener("click", async () => {
    if (!confirm("确定删除这个素材吗？TOS 文件会保留，但相册中不再展示。")) return;
    try {
      const data = await api(`/api/my/activity-projects/${encodeURIComponent(project.id)}/media/${currentIndex}`, { method: "DELETE" });
      const nextMedia = data.project?.media || [];
      if (!nextMedia.length) return loadProjectManager(project.id);
      const nextIndex = Math.min(currentIndex, nextMedia.length - 1);
      history.replaceState(null, "", projectPreviewHref(project.id, nextIndex, true));
      loadProjectPreview(project.id, nextIndex, true);
    } catch (err) { alert(err.message); }
  });
  bindProjectShareEvents();
  bindAuthEvents();
}

async function loadPublicProject(id, mediaIndex = null) {
  const data = await api(`/api/public/activity-projects/${encodeURIComponent(id)}`);
  state.currentProject = data.project;
  state.projectView = "album";
  const defaultTab = projectDefaultMediaTab(data.project);
  state.projectMediaTab = defaultTab;
  const rawIndex = mediaIndex === null || mediaIndex === undefined
    ? new URLSearchParams(location.search).get("media")
    : String(mediaIndex);
  state.selectedProjectMediaIndex = /^\d+$/.test(rawIndex || "") ? Number(rawIndex) : null;
  // 分享单个素材时只定位到缩略图，不自动打开或播放视频。
  state.projectLightboxIndex = null;
  renderProjectAlbum(state.currentProject);
}

function renderProjectAlbum(project) {
  state.projectView = "album";
  state.currentProject = project;
  state.caseView = false;
  state.currentActivity = null;
  const groups = projectMediaGroups(project);
  const tab = ["images", "videos"].includes(state.projectMediaTab) ? state.projectMediaTab : projectDefaultMediaTab(project);
  const type = projectMediaTypeForTab(tab);
  const media = (project.media || []).map((m, index) => ({ ...m, index })).filter(m => !type || m.type === type);
  app.className = `app-shell project-album-shell${isMobileProjectDownload() ? " project-mobile-mode" : ""}`;
  app.innerHTML = `${projectHeader(project.title)}
    <section class="project-album-hero"><div class="project-album-cover">${project.cover ? `<img src="${esc(project.cover)}" alt="${esc(project.title)}">` : `<div class="project-cover-empty">▣</div>`}</div><div class="project-album-copy"><div class="eyebrow"><span class="eyebrow-dot"></span>活动相册</div><div class="project-album-title-row"><h1>${esc(project.title)}</h1><span class="project-album-count">${project.media?.length || 0} 个素材</span></div><div class="project-album-meta">${esc([project.dateLabel, project.city].filter(Boolean).join(" · ") || "活动现场")}</div>${project.description ? `<p>${esc(project.description)}</p>` : ""}<div class="project-album-actions">${projectShareButton(project)}${state.user ? "" : `<button class="btn secondary small" type="button" data-open-login>登录下载</button>`}</div></div></section>${projectWeChatTip()}
    <section class="project-album-content"><div class="project-album-tabs"><button class="${tab === "images" ? "active" : ""}" data-project-tab="images">图片 <strong>${groups.images.length}</strong></button><button class="${tab === "videos" ? "active" : ""}" data-project-tab="videos">视频 <strong>${groups.videos.length}</strong></button></div>${media.length ? `<div class="project-media-grid public">${media.map(m => projectMediaCardHtml(project, m, false)).join("")}</div>` : `<div class="project-empty-state">该分类还没有素材。</div>`}</section>${projectLightboxHtml(project)}${loginModal()}`;
  document.querySelectorAll("[data-project-tab]").forEach(btn => btn.addEventListener("click", () => { state.projectMediaTab = btn.dataset.projectTab; state.projectLightboxIndex = null; renderProjectAlbum(project); }));
  bindProjectVideoThumbs();
  document.querySelectorAll("[data-project-open-media]").forEach(btn => btn.addEventListener("click", () => navigateProjectPreview(project, Number(btn.dataset.projectOpenMedia), false)));
  document.querySelectorAll("[data-project-lightbox-close]").forEach(btn => btn.addEventListener("click", () => { state.projectLightboxIndex = null; renderProjectAlbum(project); }));
  document.querySelectorAll("[data-project-lightbox-nav]").forEach(btn => btn.addEventListener("click", () => { state.projectLightboxIndex = Number(btn.dataset.projectLightboxNav); renderProjectAlbum(project); }));
  document.querySelector(".project-lightbox")?.addEventListener("click", e => { if (e.target.classList.contains("project-lightbox")) { state.projectLightboxIndex = null; renderProjectAlbum(project); } });
  document.querySelectorAll("[data-project-download]").forEach(btn => btn.addEventListener("click", async () => { try { const data = await api(`/api/public/activity-projects/${encodeURIComponent(project.id)}/download?i=${btn.dataset.projectDownload}`); if (data.url) triggerProjectDownload(data.url, data.filename || `activity-${project.id}-${btn.dataset.projectDownload}`, project.media[Number(btn.dataset.projectDownload)]?.type); } catch (err) { alert(err.message); } }));
  document.querySelectorAll("[data-project-login]").forEach(btn => btn.addEventListener("click", () => { state.loginOpen = true; state.authMessage = ""; state.authTab = "login"; renderProjectAlbum(project); }));
  bindProjectShareEvents();
  bindAuthEvents();
  const selected = document.querySelector(`[data-project-media-index="${state.selectedProjectMediaIndex}"]`);
  selected?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function startHeroCaseCarousel() {
  const dots = document.querySelectorAll(".hero-case-dot");
  const items = document.querySelectorAll(".hero-case-item");
  if (!document.querySelector(".hero-case-slider") || items.length === 0) return;
  if (window.__heroCaseTimer) {
    clearInterval(window.__heroCaseTimer);
    window.__heroCaseTimer = null;
  }
  let idx = 0;
  const go = n => {
    idx = n;
    items.forEach((el, i) => el.classList.toggle("active", i === idx));
    dots.forEach((dot, i) => dot.classList.toggle("active", i === idx));
  };
  if (items.length >= 2) {
    window.__heroCaseTimer = setInterval(() => go((idx + 1) % items.length), 5000);
    dots.forEach((dot, i) => {
      if (!dot.dataset.bound) {
        dot.dataset.bound = "1";
        dot.addEventListener("click", () => {
          go(i);
          clearInterval(window.__heroCaseTimer);
          window.__heroCaseTimer = setInterval(() => go((idx + 1) % items.length), 5000);
        });
      }
    });
  }
  go(0);
}

function startHeroCarousel() {
  startHeroCaseCarousel();
}

// ---- 精彩案例页 ----
function casePlatform(url) {
  const u = String(url || "");
  if (/weixin|channels\.weixin|wx\./i.test(u)) return "视频号";
  if (/douyin|iesdouyin/i.test(u)) return "抖音";
  if (/xiaohongshu|xhslink/i.test(u)) return "小红书";
  return "外部视频";
}

function caseMediaSummary(c) {
  const media = Array.isArray(c.media) ? c.media : [];
  return {
    imgs: media.filter(m => m.type === "image"),
    videos: media.filter(m => m.type === "video"),
    documents: media.filter(m => m.type === "document"),
    links: media.filter(m => m.type === "link")
  };
}

function caseCoverUrl(c) {
  if (c.cover) return c.cover;
  const s = caseMediaSummary(c);
  if (s.imgs.length) return s.imgs[0].url;
  return fallbackCover();
}

function caseHref(id) {
  return `${SILVER_FRONT_BASE}/?view=cases&case=${encodeURIComponent(id)}`;
}

function caseTabForMediaType(type) {
  if (type === "video") return "videos";
  if (type === "image") return "images";
  if (type === "document") return "documents";
  return "links";
}

function caseMediaLabel(m) {
  if (m.type === "image") return "图片";
  if (m.type === "video") return "视频";
  if (m.type === "document") return "文档";
  return casePlatform(m.url);
}

function fileNameFromUrl(url) {
  try {
    const raw = String(url || "").split("?")[0].split("#")[0];
    return decodeURIComponent(raw.split("/").pop() || "");
  } catch {
    return String(url || "").split("?")[0].split("#")[0].split("/").pop() || "";
  }
}

function groupedCaseMedia(c) {
  const groups = { videos: [], images: [], documents: [], links: [] };
  (Array.isArray(c.media) ? c.media : []).forEach((m, index) => {
    const item = { ...m, index };
    if (m.type === "video") groups.videos.push(item);
    else if (m.type === "image") groups.images.push(item);
    else if (m.type === "document") groups.documents.push(item);
    else groups.links.push(item);
  });
  return groups;
}

function hydrateCaseVideoThumbs() {
  const thumbs = Array.from(document.querySelectorAll(".case-video-thumb[data-thumb-src]"));
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

async function loadCases() {
  const data = await api("/api/public/cases");
  state.cases = data.cases || [];
  state.caseCategories = data.categories || [];
  state.caseView = true;
  const qs = new URLSearchParams(location.search);
  state.activeCaseId = qs.get("case") || state.activeCaseId || "";
  const rawMediaIndex = qs.get("media");
  state.selectedCaseMediaIndex = /^\d+$/.test(rawMediaIndex || "") ? Number(rawMediaIndex) : null;
  const selectedCase = state.cases.find(c => c.id === state.activeCaseId);
  const selectedMedia = selectedCase?.media?.[state.selectedCaseMediaIndex];
  state.caseMediaTab = selectedMedia ? caseTabForMediaType(selectedMedia.type) : state.caseMediaTab;
  if (state.activeCaseId) renderCasePage(state.activeCaseId);
  else renderCases();
}

function caseCard(c) {
  const s = caseMediaSummary(c);
  const isVideo = s.videos.length > 0 || (s.imgs.length === 0 && s.links.length > 0);
  const badge = s.videos.length > 0
    ? `<span class="case-badge">▶ 视频</span>`
    : s.links.length > 0 && s.imgs.length === 0
    ? `<span class="case-badge">${esc(casePlatform(s.links[0].url))}</span>`
    : "";
  const countBadge = c.media?.length ? `<span class="case-count">${c.media.length}个素材</span>` : "";
  return `
    <article class="case-card" data-case="${esc(c.id)}">
      <div class="case-card-img">
        <img src="${esc(caseCoverUrl(c))}" alt="${esc(c.title)}" loading="lazy">
        ${isVideo ? `<div class="case-play"><span>▶</span></div>` : ""}
        ${badge}${countBadge}
      </div>
      <div class="case-card-body">
        <p class="case-title">${esc(c.title)}</p>
        <div class="case-meta">
          ${c.category ? `<span class="badge badge-cat">${esc(c.category)}</span>` : ""}
          <span class="case-sub">${esc([c.city, c.dateLabel].filter(Boolean).join(" · "))}</span>
        </div>
        <div class="case-card-actions">
          <div class="case-card-structure">${s.videos.length} 视频 / ${s.imgs.length} 图片 / ${s.documents.length} 文档 / ${s.links.length} 链接</div>
          <button class="btn secondary small case-share-btn" type="button" data-share-case="${esc(c.id)}">📤 分享案例</button>
        </div>
      </div>
    </article>`;
}

function renderCases() {
  state.caseView = true;
  state.currentActivity = null;
  const cats = state.caseCategories;
  const list = state.caseFilter ? state.cases.filter(c => c.category === state.caseFilter) : state.cases;

  app.className = "app-shell";
  app.innerHTML = `
    <header class="site-header">
      <a class="brand-mark" href="${homeHref()}">
        <div class="brand-icon"></div>
        <span>开开华彩</span>
      </a>
      <nav>
        <a href="${homeHref()}">活动库</a>
        <a href="?view=cases" style="color:var(--accent);font-weight:600">精彩案例</a>
        ${state.user?.role === "admin" ? `<a href="${adminHref()}">管理后台</a>` : ""}
        <div class="auth-actions">${authBar()}</div>
      </nav>
      ${mobilePrimaryNav("cases")}
    </header>

    <section class="cases-head">
      <h1>精彩案例</h1>
      <p>全国俱乐部与社群的优秀活动实录 · 视频与图片直接看，学习即可落地</p>
      <div class="case-chips">
        <button class="case-chip ${!state.caseFilter ? "active" : ""}" data-case-cat="">全部</button>
        ${cats.map(cat => `<button class="case-chip ${state.caseFilter === cat ? "active" : ""}" data-case-cat="${esc(cat)}">${esc(cat)}</button>`).join("")}
      </div>
    </section>

	    ${list.length
	      ? `<div class="case-grid">${list.map(caseCard).join("")}</div>`
	      : `<div class="case-empty">该分类暂无案例，敬请期待</div>`}
	    ${loginModal()}`;

  document.querySelectorAll("[data-case-cat]").forEach(btn =>
    btn.addEventListener("click", () => { state.caseFilter = btn.dataset.caseCat; renderCases(); }));
		  document.querySelectorAll("[data-case]").forEach(card =>
			    card.addEventListener("click", () => {
			      state.activeCaseId = card.dataset.case;
			      state.caseMediaTab = "";
            state.selectedCaseMediaIndex = null;
			      history.pushState(null, "", caseHref(state.activeCaseId));
			      renderCasePage(state.activeCaseId);
			    }));
    document.querySelectorAll("[data-share-case]").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      return shareLink({
        url: caseShareHref(btn.dataset.shareCase),
        title: "分享精彩案例",
        text: "开开华彩精彩案例",
        button: btn
      });
    }));
	  bindAuthEvents();
	}

function caseDownloadAction(caseId, m) {
  if (m.type === "link") return "";
  const label = m.type === "video" ? "视频" : (m.type === "document" ? "文档" : "原图");
  return state.user
    ? `<button class="btn small" data-case-download="${m.index}">下载${label}</button>`
    : `<button class="btn secondary small" data-case-login>登录或申请账号后下载</button>`;
}

function caseShareAction(caseId, m) {
  return `<button class="btn secondary small" type="button" data-share-case-media="${m.index}">📤 分享</button>`;
}

function renderCasePage(caseId) {
  const c = state.cases.find(x => x.id === caseId);
  if (!c) {
    state.activeCaseId = "";
    return renderCases();
  }
  const shouldAuditCase = lastAuditedCaseId !== caseId;
  lastAuditedCaseId = caseId;
  const media = Array.isArray(c.media) ? c.media : [];
  const groups = groupedCaseMedia(c);
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
          const platform = casePlatform(m.url);
          const label = m.caption || m.title || "外部平台内容，点击跳转观看";
          return `
            <article class="case-link-row">
              <div class="case-link-row-main">
                <div class="case-link-row-head">
                  <strong>${esc(platform)}</strong>
                  <span>#${m.index + 1}</span>
                </div>
                <p>${esc(label)}</p>
                <a class="case-link-url" href="${esc(m.url)}" target="_blank" rel="noreferrer">${esc(m.url)}</a>
              </div>
              <div class="case-link-row-actions">
                <a class="btn small" href="${esc(m.url)}" target="_blank" rel="noreferrer">打开链接</a>
                ${caseShareAction(c.id, m)}
              </div>
            </article>`;
        }
		    const body = m.type === "image"
		      ? `<img src="${esc(m.url)}" alt="${esc(c.title)}" loading="lazy" data-case-image-view="${m.index}">`
		      : m.type === "video"
		      ? `<button class="case-video-poster" type="button" data-case-video-play="${esc(m.url)}">
		          <video class="case-video-thumb" data-thumb-src="${esc(m.url)}#t=0.5" muted playsinline preload="metadata"></video>
		          <span class="case-play-icon">▶</span>
		          <strong>点击播放</strong>
		        </button>`
          : m.type === "document"
          ? `<div class="case-doc-panel">
          <strong>文档</strong>
          <p>${esc(m.caption || m.title || fileNameFromUrl(m.url) || "案例文档素材")}</p>
        </div>`
	      : "";
    return `
      <article class="case-media-card ${state.selectedCaseMediaIndex === m.index ? "share-target" : ""}" data-case-media-index="${m.index}">
        <div class="case-media-visual">${body}</div>
        <div class="case-media-info">
          <div>
            <strong>${esc(caseMediaLabel(m))}</strong>
            <span>#${m.index + 1}</span>
          </div>
          ${(m.caption || m.title) && m.type !== "link" ? `<p>${esc(m.caption || m.title)}</p>` : ""}
          <div class="case-media-actions">
            ${caseShareAction(c.id, m)}
            ${caseDownloadAction(c.id, m)}
          </div>
        </div>
      </article>`;
  };
	  const section = (title, items, emptyText) => `
	    <section class="case-section">
	      <div class="case-section-head">
	        <h2>${esc(title)}</h2>
	        <span>${items.length} 个</span>
	      </div>
      ${items.length ? `<div class="${items[0]?.type === "link" ? "case-link-list" : `case-media-grid ${items[0]?.type === "image" ? "images" : items[0]?.type === "video" ? "videos" : ""}`}">${items.map(mediaCard).join("")}</div>`
        : `<div class="case-section-empty">${esc(emptyText)}</div>`}
    </section>`;

  state.caseView = true;
  state.activeCaseId = caseId;
  state.currentActivity = null;
  app.className = "app-shell";
  app.innerHTML = `
    <header class="site-header">
      <a class="brand-mark" href="${homeHref()}">
        <div class="brand-icon"></div>
        <span>开开华彩</span>
      </a>
      <nav>
        <a href="${homeHref()}">活动库</a>
        <a href="?view=cases" style="color:var(--accent);font-weight:600">精彩案例</a>
        ${state.user?.role === "admin" ? `<a href="${adminHref()}">管理后台</a>` : ""}
        <div class="auth-actions">${authBar()}</div>
      </nav>
      ${mobilePrimaryNav("cases")}
    </header>
    <section class="case-page-head">
      <button class="btn secondary" id="caseBackList">返回案例列表</button>
      <div class="case-page-cover">
        <img src="${esc(caseCoverUrl(c))}" alt="${esc(c.title)}">
      </div>
      <div class="case-page-copy">
        <div class="case-page-kicker">${esc([c.category, c.city, c.dateLabel].filter(Boolean).join(" · ") || "精彩案例")}</div>
        <h1>${esc(c.title)}</h1>
        ${c.description ? `<p>${esc(c.description)}</p>` : ""}
        <div class="case-page-stats">
          <span>${groups.videos.length} 个视频</span>
          <span>${groups.images.length} 张图片</span>
          <span>${groups.documents.length} 个文档</span>
          <span>${groups.links.length} 个链接</span>
        </div>
        <div class="case-page-actions">
          <button class="btn secondary small" type="button" id="shareCaseBtn">📤 分享案例</button>
          <span class="case-download-note">精彩案例素材下载需登录或申请账号</span>
        </div>
      </div>
    </section>
    <div class="case-page-material-tabs" role="tablist" aria-label="案例素材分类">
      ${tabs.map(t => `
        <button class="case-page-material-tab ${t.key === activeTab ? "active" : ""}" type="button" data-case-media-tab="${esc(t.key)}" role="tab" aria-selected="${t.key === activeTab ? "true" : "false"}">
          <span>${esc(t.title)}</span>
          <strong>${t.items.length} 个</strong>
        </button>`).join("")}
    </div>
    ${section(activeGroup.title, activeGroup.items, activeGroup.empty)}
    ${loginModal()}`;
  hydrateCaseVideoThumbs();

  document.querySelector("#caseBackList").addEventListener("click", () => {
    state.activeCaseId = "";
    lastAuditedCaseId = "";
    state.caseMediaTab = "";
    state.selectedCaseMediaIndex = null;
    history.pushState(null, "", `${SILVER_FRONT_BASE}/?view=cases`);
    renderCases();
  });

  const shareCaseBtn = document.querySelector("#shareCaseBtn");
  if (shareCaseBtn) shareCaseBtn.addEventListener("click", () => shareLink({
    url: caseShareHref(c.id),
    title: c.title || "分享精彩案例",
    text: `${c.title || "精彩案例"} · 开开华彩案例素材`,
    button: shareCaseBtn
  }));

  document.querySelectorAll("[data-share-case-media]").forEach(btn => btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    return shareLink({
      url: caseShareHref(c.id, Number(btn.dataset.shareCaseMedia)),
      title: `${c.title || "精彩案例"} · 分享素材`,
      text: `${c.title || "精彩案例"} · 开开华彩案例素材`,
      button: btn
    });
  }));

  const selectedCaseNode = document.querySelector(`[data-case-media-index="${state.selectedCaseMediaIndex}"]`);
  selectedCaseNode?.scrollIntoView({ behavior: "smooth", block: "center" });

		  document.querySelectorAll("[data-case-media-tab]").forEach(btn => btn.addEventListener("click", () => {
		    state.caseMediaTab = btn.dataset.caseMediaTab || "";
		    renderCasePage(caseId);
		  }));
		  document.querySelectorAll("[data-case-download]").forEach(btn => btn.addEventListener("click", async () => {
		    const href = apiHref(`/api/public/cases/${encodeURIComponent(caseId)}/download?i=${btn.dataset.caseDownload}`);
		    try {
		      const res = await fetch(href, { credentials: "include" });
		      const type = res.headers.get("content-type") || "";
		      if (type.includes("application/json")) {
		        const data = await res.json();
		        if (data.url) window.open(data.url, "_blank");
		        else throw new Error(data.error || "下载失败");
		      } else {
		        window.open(href, "_blank");
		      }
		    } catch {
		      window.open(href, "_blank");
		    }
		  }));
	  document.querySelectorAll("[data-case-video-play]").forEach(btn => btn.addEventListener("click", () => {
	    const url = btn.dataset.caseVideoPlay;
	    const wrap = btn.closest(".case-media-visual");
	    if (!url || !wrap) return;
	    wrap.innerHTML = `<video src="${esc(url)}" controls preload="metadata" playsinline></video>`;
	    const video = wrap.querySelector("video");
	    video?.addEventListener("play", () => { void trackMediaView("case_media", caseId, Number(btn.closest("[data-case-media-index]")?.dataset.caseMediaIndex)); }, { once: true });
	  }));
	  document.querySelectorAll("[data-case-image-view]").forEach(image => {
	    const send = () => { void trackMediaView("case_media", caseId, Number(image.dataset.caseImageView)); };
	    image.addEventListener("load", send, { once: true });
	    if (image.complete) send();
	  });
	  document.querySelectorAll("[data-case-login]").forEach(btn => btn.addEventListener("click", () => {
    state.loginOpen = true; state.authMessage = ""; state.authOk = false; state.authTab = "login";
    renderCasePage(caseId);
  }));
  bindAuthEvents();
  if (shouldAuditCase) void trackMediaView("case", c.id, null);
}

async function boot() {
  try {
    const [meResult, configResult, bannersResult] = await Promise.allSettled([
      api("/api/me"),
      api('/api/site-config'),
      fetch(apiUrl('/api/banners')).then(r => r.json())
    ]);
    state.user = meResult.status === "fulfilled" ? meResult.value.user : null;
    state.siteConfig = configResult.status === "fulfilled" ? (configResult.value.config || {}) : {};
    state.banners = bannersResult.status === "fulfilled" ? (bannersResult.value.banners || []) : [];
  } catch {
    state.user = null;
    state.siteConfig = {};
    state.banners = [];
  }
  // 免登录浏览：不再强制弹登录，只有导出 SOP / 共创时才需要登录
  try {
    const qs = new URLSearchParams(location.search);
    const view = qs.get("view");
    const sharedProject = parseProjectShareValue(qs.get("share"));
    if (sharedProject) {
      if (sharedProject.mediaIndex === null) await loadPublicProject(sharedProject.projectId);
      else await loadProjectPreview(sharedProject.projectId, sharedProject.mediaIndex);
      return;
    }
    if (view === "projects") {
      await loadProjectsView();
      return;
    }
    if (view === "project-manage") {
      await loadProjectManager(qs.get("project"));
      return;
    }
    if (view === "project-preview" && qs.get("project")) {
      await loadProjectPreview(qs.get("project"), qs.get("media"), qs.get("mode") === "manage");
      return;
    }
    if (view === "project" && qs.get("project")) {
      await loadPublicProject(qs.get("project"));
      return;
    }
    if (view === "cases") {
      await loadCases();
      return;
    }
    const activityId = new URLSearchParams(location.search).get("activity");
    if (activityId) await loadDetail(activityId);
    else await loadList();
  } catch (err) {
    app.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

window.addEventListener("popstate", () => {
  const qs = new URLSearchParams(location.search);
  const sharedProject = parseProjectShareValue(qs.get("share"));
  if (sharedProject) {
    if (sharedProject.mediaIndex === null) loadPublicProject(sharedProject.projectId);
    else loadProjectPreview(sharedProject.projectId, sharedProject.mediaIndex);
    return;
  }
  if (qs.get("view") === "projects") { loadProjectsView(); return; }
  if (qs.get("view") === "project-manage") { loadProjectManager(qs.get("project")); return; }
  if (qs.get("view") === "project-preview" && qs.get("project")) { loadProjectPreview(qs.get("project"), qs.get("media"), qs.get("mode") === "manage"); return; }
  if (qs.get("view") === "project" && qs.get("project")) { loadPublicProject(qs.get("project")); return; }
  if (qs.get("view") === "cases") {
    state.activeCaseId = qs.get("case") || "";
    const rawMediaIndex = qs.get("media");
    state.selectedCaseMediaIndex = /^\d+$/.test(rawMediaIndex || "") ? Number(rawMediaIndex) : null;
    if (state.cases.length) {
      const selectedCase = state.cases.find(c => c.id === state.activeCaseId);
      const selectedMedia = selectedCase?.media?.[state.selectedCaseMediaIndex];
      state.caseMediaTab = selectedMedia ? caseTabForMediaType(selectedMedia.type) : "";
      if (state.activeCaseId) renderCasePage(state.activeCaseId);
      else renderCases();
    } else {
      loadCases();
    }
    return;
  }
  state.caseView = false;
  state.activeCaseId = "";
  state.projectView = "";
  state.currentProject = null;
  const activityId = qs.get("activity");
  if (activityId) loadDetail(activityId);
  else {
    state.selectedActivityMedia = null;
    loadList();
  }
});

boot();


function saveContributeForm() {
  const form = document.querySelector("#contributeForm");
  if (!form) return;
  state.contributeDraft = state.contributeDraft || {};
  form.querySelectorAll("[name]").forEach(el => {
    if (el.type === "checkbox") state.contributeDraft[el.name] = el.checked;
    else state.contributeDraft[el.name] = el.value;
  });
}
function syncContributeRows() {
  document.querySelectorAll("#contributeRowsBox .contribute-row").forEach(row => {
    const i = Number(row.dataset.row);
    if (!state.contributeRows[i]) return;
    state.contributeRows[i].time = row.querySelector("[data-c-time]")?.value || "";
    state.contributeRows[i].item = row.querySelector("[data-c-item]")?.value || "";
  });
}
function bindContributeRows() {
  document.querySelectorAll("#contributeRowsBox [data-c-del]").forEach(btn =>
    btn.addEventListener("click", () => {
      syncContributeRows();
      state.contributeRows.splice(Number(btn.dataset.cDel), 1);
      if (!state.contributeRows.length) state.contributeRows.push({ time: "", item: "" });
      const box = document.querySelector("#contributeRowsBox");
      if (box) { box.innerHTML = contributeRowsHtml(); bindContributeRows(); }
    }));
}
