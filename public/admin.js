const adminApp = document.querySelector("#adminApp");

const state = {
  user: null,
  activities: [],
  users: [],
  activeTab: "activities",
  editingId: null,
  imageUrls: [],
  message: ""
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(url, options = {}) {
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

function flash(message, type = "") {
  state.message = `<div class="message ${type}">${esc(message)}</div>`;
}

function clearFlash() {
  state.message = "";
}

function lines(value) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

function scheduleLines(value) {
  return Array.isArray(value) ? value.map(x => `${x.time || ""} - ${x.item || ""}`.trim()).join("\n") : "";
}

function parseLines(value) {
  return String(value || "").split("\n").map(x => x.trim()).filter(Boolean);
}

function parseSchedule(value) {
  return String(value || "").split("\n").map(line => {
    const [time, ...rest] = line.split(/\s*[-|｜]\s*/);
    return { time: (time || "").trim(), item: rest.join(" - ").trim() || (time || "").trim() };
  }).filter(x => x.item);
}

function roleLabel(role) {
  return {
    admin: "总部管理员",
    operator: "城市主理人",
    viewer: "只读账号",
    member: "普通学习用户"
  }[role] || role;
}

function statusLabel(status) {
  return {
    published: "已发布",
    pending: "待审核",
    draft: "草稿",
    rejected: "已驳回"
  }[status] || status || "未设置";
}

function statusClass(status) {
  return status === "published" ? "" : ` ${status || "draft"}`;
}

function showLogin(error = "") {
  adminApp.innerHTML = `
    <section class="login-shell">
      <div class="login-visual">
        <h1>同城银发活动展示后台</h1>
        <p>总部可管理活动方案、图片素材和账号权限，城市主理人可发布本地活动并生成 H5 展示页。</p>
      </div>
      <div class="login-panel">
        <form class="login-card" id="loginForm">
          <h2>登录后台</h2>
          <p>演示账号：admin / admin123；城市主理人：city / city123；普通用户：member / member123。</p>
          ${error ? `<div class="message error">${esc(error)}</div>` : ""}
          <div class="field">
            <label for="username">账号</label>
            <input class="input" id="username" autocomplete="username" value="admin">
          </div>
          <div class="field">
            <label for="password">密码</label>
            <input class="input" id="password" type="password" autocomplete="current-password" value="admin123">
          </div>
          <button class="btn" type="submit">进入后台</button>
        </form>
      </div>
    </section>
  `;
  document.querySelector("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: {
          username: document.querySelector("#username").value.trim(),
          password: document.querySelector("#password").value
        }
      });
      state.user = data.user;
      await refreshData();
      renderShell();
    } catch (err) {
      showLogin(err.message);
    }
  });
}

async function refreshData() {
  const activityData = await api("/api/admin/activities");
  state.activities = activityData.activities || [];
  if (state.user?.role === "admin") {
    const userData = await api("/api/admin/users");
    state.users = userData.users || [];
  }
}

function renderShell() {
  adminApp.innerHTML = `
    <section class="layout">
      <aside class="sidebar">
        <div class="brand">
          <strong>活动管理后台</strong>
          <span>${esc(state.user.name)} · ${esc(roleLabel(state.user.role))}</span>
        </div>
        <nav class="nav">
          <button data-tab="activities" class="${state.activeTab === "activities" ? "active" : ""}">活动方案</button>
          ${state.user.role === "admin" ? `<button data-tab="users" class="${state.activeTab === "users" ? "active" : ""}">账号权限</button>` : ""}
          ${state.user.role !== "viewer" ? `<button data-tab="import" class="${state.activeTab === "import" ? "active" : ""}">导入审核</button>` : ""}
          <button data-tab="preview" class="${state.activeTab === "preview" ? "active" : ""}">前台入口</button>
        </nav>
        <div class="side-foot">
          <button class="btn ghost" id="logoutBtn">退出登录</button>
        </div>
      </aside>
      <main class="main">
        <div id="content"></div>
      </main>
    </section>
  `;
  document.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      clearFlash();
      renderShell();
    });
  });
  document.querySelector("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: {} });
    state.user = null;
    showLogin();
  });
  renderContent();
}

function renderContent() {
  if (state.activeTab === "users") renderUsers();
  else if (state.activeTab === "import") renderImport();
  else if (state.activeTab === "preview") renderPreview();
  else renderActivities();
}

function activityListItem(activity) {
  return `
    <article class="activity-row">
      <img src="${esc(activity.cover || "/assets/people/cn-social-cafe.jpg")}" alt="${esc(activity.title)}">
      <div>
        <h3>${esc(activity.title)}</h3>
        <p>${esc(activity.city || "同城")} · ${esc(activity.region || "地区待补充")} · ${esc(activity.category)} · ${esc(activity.price)} <span class="status${statusClass(activity.status)}">${statusLabel(activity.status)}</span></p>
        <div class="mini-actions">
          <button class="mini-btn" data-edit="${esc(activity.id)}">编辑</button>
          <a class="mini-btn" href="/activity/${encodeURIComponent(activity.id)}" target="_blank">预览</a>
          ${state.user.role !== "viewer" ? `<button class="mini-btn" data-delete="${esc(activity.id)}">删除</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function emptyActivity() {
  return {
    status: "published",
    title: "",
    city: "同城模板",
    region: "全国通用",
    category: "高光美学与声乐系列",
    activityType: "",
    price: "",
    capacity: "",
    duration: "",
    location: "",
    cover: "",
    images: [],
    videos: [],
    references: [],
    tags: [],
    intro: "",
    highlights: [],
    schedule: [],
    plan: { target: "", materials: "", staffing: "", conversion: "", risk: "" },
    downloadEnabled: true,
    reviewNote: "",
    contact: "评论区留言，主理人联系您"
  };
}

function currentActivity() {
  return state.activities.find(x => x.id === state.editingId) || emptyActivity();
}

function renderActivities() {
  const content = document.querySelector("#content");
  const activity = currentActivity();
  state.imageUrls = Array.isArray(activity.images) ? [...activity.images] : [];
  content.innerHTML = `
    <div class="topbar">
      <div>
        <h1>活动方案</h1>
        <p>发布图片、活动内容和主理人执行方案，生成可转发的 H5 页面。</p>
      </div>
      <button class="btn secondary" id="newActivity">新建活动</button>
    </div>
    ${state.message}
    <div class="grid">
      <section class="panel">
        <div class="toolbar">
          <h2>活动列表</h2>
          <span class="help">共 ${state.activities.length} 个</span>
        </div>
        <div class="activity-list">
          ${state.activities.map(activityListItem).join("") || `<div class="center-state">暂无活动</div>`}
        </div>
      </section>
      <section class="panel">
        <h2>${state.editingId ? "编辑活动" : "新建活动"}</h2>
        <form id="activityForm">
          <div class="row three">
            <div class="field">
              <label>状态</label>
              <select class="select" name="status" ${state.user.role === "viewer" ? "disabled" : ""}>
                <option value="published" ${activity.status === "published" ? "selected" : ""}>已发布</option>
                <option value="pending" ${activity.status === "pending" ? "selected" : ""}>待审核</option>
                <option value="draft" ${activity.status === "draft" ? "selected" : ""}>草稿</option>
                <option value="rejected" ${activity.status === "rejected" ? "selected" : ""}>已驳回</option>
              </select>
            </div>
            <div class="field">
              <label>城市</label>
              <input class="input" name="city" value="${esc(activity.city)}" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
            <div class="field">
              <label>地区备注</label>
              <input class="input" name="region" value="${esc(activity.region || activity.city)}" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>活动大类</label>
              <input class="input" name="category" value="${esc(activity.category)}" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
            <div class="field">
              <label>细分活动类型</label>
              <input class="input" name="activityType" value="${esc(activity.activityType || activity.category)}" placeholder="例如 KTV、掼蛋、声乐体验、旗袍走秀" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
          </div>
          <div class="field">
            <label>活动标题</label>
            <input class="input" name="title" value="${esc(activity.title)}" ${state.user.role === "viewer" ? "disabled" : ""}>
          </div>
          <div class="field">
            <label>活动简介</label>
            <textarea class="textarea" name="intro" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(activity.intro)}</textarea>
          </div>
          <div class="row three">
            <div class="field">
              <label>价格</label>
              <input class="input" name="price" value="${esc(activity.price)}" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
            <div class="field">
              <label>人数</label>
              <input class="input" name="capacity" value="${esc(activity.capacity)}" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
            <div class="field">
              <label>时长</label>
              <input class="input" name="duration" value="${esc(activity.duration)}" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
          </div>
          <div class="field">
            <label>地点</label>
            <input class="input" name="location" value="${esc(activity.location)}" ${state.user.role === "viewer" ? "disabled" : ""}>
          </div>
          <div class="row">
            <div class="field">
              <label>标签，每行一个</label>
              <textarea class="textarea" name="tags" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(lines(activity.tags))}</textarea>
            </div>
            <div class="field">
              <label>活动亮点，每行一个</label>
              <textarea class="textarea" name="highlights" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(lines(activity.highlights))}</textarea>
            </div>
          </div>
          <div class="field">
            <label>活动流程，每行一条，格式：14:00 - 签到</label>
            <textarea class="textarea" name="schedule" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(scheduleLines(activity.schedule))}</textarea>
          </div>
          <div class="row">
            <div class="field">
              <label>运营目标</label>
              <textarea class="textarea" name="target" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(activity.plan?.target)}</textarea>
            </div>
            <div class="field">
              <label>核心物料</label>
              <textarea class="textarea" name="materials" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(activity.plan?.materials)}</textarea>
            </div>
            <div class="field">
              <label>人力配置</label>
              <textarea class="textarea" name="staffing" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(activity.plan?.staffing)}</textarea>
            </div>
            <div class="field">
              <label>转化承接</label>
              <textarea class="textarea" name="conversion" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(activity.plan?.conversion)}</textarea>
            </div>
          </div>
          <div class="field">
            <label>风险控制</label>
            <textarea class="textarea" name="risk" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(activity.plan?.risk)}</textarea>
          </div>
          <div class="field">
            <label>报名/咨询提示</label>
            <input class="input" name="contact" value="${esc(activity.contact)}" ${state.user.role === "viewer" ? "disabled" : ""}>
          </div>
          <div class="field">
            <label>图片上传</label>
            <input class="input" id="imageInput" type="file" accept="image/*" multiple ${state.user.role === "viewer" ? "disabled" : ""}>
            <span class="help">第一张图片会默认作为封面，也可以在封面地址中手动指定。</span>
            <div class="images" id="imagePreview">${renderThumbs()}</div>
          </div>
          <div class="field">
            <label>封面地址</label>
            <input class="input" name="cover" id="coverInput" value="${esc(activity.cover)}" ${state.user.role === "viewer" ? "disabled" : ""}>
          </div>
          <div class="row">
            <div class="field">
              <label>视频参考链接，每行一个</label>
              <textarea class="textarea" name="videos" placeholder="可粘贴视频号、小程序或素材库链接" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(lines(activity.videos))}</textarea>
            </div>
            <div class="field">
              <label>方案参考链接，每行一个</label>
              <textarea class="textarea" name="references" placeholder="可粘贴小程序活动、飞书文档或内部素材链接" ${state.user.role === "viewer" ? "disabled" : ""}>${esc(lines(activity.references))}</textarea>
            </div>
          </div>
          <div class="row">
            <label class="checkline">
              <input type="checkbox" name="downloadEnabled" ${activity.downloadEnabled === false ? "" : "checked"} ${state.user.role === "viewer" ? "disabled" : ""}>
              <span>允许已授权用户下载 SOP</span>
            </label>
            <div class="field">
              <label>审核备注</label>
              <input class="input" name="reviewNote" value="${esc(activity.reviewNote)}" placeholder="例如 图片待补、视频待审核、地区信息待确认" ${state.user.role === "viewer" ? "disabled" : ""}>
            </div>
          </div>
          <input type="hidden" name="images" id="imagesInput" value="${esc(state.imageUrls.join("\n"))}">
          <div class="mini-actions">
            <button class="btn" type="submit" ${state.user.role === "viewer" ? "disabled" : ""}>保存活动</button>
            <button class="btn secondary" type="button" id="resetForm">清空表单</button>
          </div>
        </form>
      </section>
    </div>
  `;
  bindActivityEvents();
}

function renderThumbs() {
  return state.imageUrls.map((url, index) => `
    <div class="thumb">
      <img src="${esc(url)}" alt="活动图${index + 1}">
      <button type="button" data-remove-image="${index}">×</button>
    </div>
  `).join("");
}

function syncImages() {
  const input = document.querySelector("#imagesInput");
  const cover = document.querySelector("#coverInput");
  const preview = document.querySelector("#imagePreview");
  if (input) input.value = state.imageUrls.join("\n");
  if (cover && !cover.value && state.imageUrls[0]) cover.value = state.imageUrls[0];
  if (preview) preview.innerHTML = renderThumbs();
  document.querySelectorAll("[data-remove-image]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.imageUrls.splice(Number(btn.dataset.removeImage), 1);
      syncImages();
    });
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function bindActivityEvents() {
  document.querySelector("#newActivity").addEventListener("click", () => {
    state.editingId = null;
    clearFlash();
    renderActivities();
  });
  document.querySelector("#resetForm").addEventListener("click", () => {
    state.editingId = null;
    clearFlash();
    renderActivities();
  });
  document.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.editingId = btn.dataset.edit;
      clearFlash();
      renderActivities();
    });
  });
  document.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除这个活动吗？")) return;
      try {
        await api(`/api/admin/activities/${encodeURIComponent(btn.dataset.delete)}`, { method: "DELETE" });
        await refreshData();
        state.editingId = null;
        flash("活动已删除");
        renderActivities();
      } catch (err) {
        flash(err.message, "error");
        renderActivities();
      }
    });
  });
  syncImages();
  document.querySelector("#imageInput").addEventListener("change", async event => {
    const files = [...event.target.files];
    if (!files.length) return;
    try {
      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file);
        const data = await api("/api/admin/upload-image", {
          method: "POST",
          body: { dataUrl, fileName: file.name }
        });
        state.imageUrls.push(data.url);
      }
      syncImages();
      flash("图片上传完成");
    } catch (err) {
      flash(err.message, "error");
    }
    event.target.value = "";
    renderActivities();
  });
  document.querySelector("#activityForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      status: form.get("status"),
      title: form.get("title"),
      city: form.get("city"),
      region: form.get("region"),
      category: form.get("category"),
      activityType: form.get("activityType"),
      price: form.get("price"),
      capacity: form.get("capacity"),
      duration: form.get("duration"),
      location: form.get("location"),
      cover: form.get("cover") || state.imageUrls[0] || "",
      images: state.imageUrls,
      videos: parseLines(form.get("videos")),
      references: parseLines(form.get("references")),
      tags: parseLines(form.get("tags")),
      intro: form.get("intro"),
      highlights: parseLines(form.get("highlights")),
      schedule: parseSchedule(form.get("schedule")),
      target: form.get("target"),
      materials: form.get("materials"),
      staffing: form.get("staffing"),
      conversion: form.get("conversion"),
      risk: form.get("risk"),
      downloadEnabled: form.get("downloadEnabled") === "on",
      reviewNote: form.get("reviewNote"),
      contact: form.get("contact")
    };
    try {
      if (state.editingId) {
        await api(`/api/admin/activities/${encodeURIComponent(state.editingId)}`, { method: "PUT", body: payload });
        flash("活动已更新");
      } else {
        const data = await api("/api/admin/activities", { method: "POST", body: payload });
        state.editingId = data.activity.id;
        flash("活动已创建");
      }
      await refreshData();
      renderActivities();
    } catch (err) {
      flash(err.message, "error");
      renderActivities();
    }
  });
}

function renderImport() {
  const content = document.querySelector("#content");
  const sample = [
    {
      title: "同城KTV怀旧金曲局",
      city: "北京",
      region: "朝阳区",
      category: "同城社交与情感系列",
      activityType: "KTV欢唱",
      price: "AA制或69元/人",
      capacity: "20-40人",
      duration: "3小时",
      location: "同城KTV包厢",
      intro: "通过怀旧金曲把同龄用户聚到一起，适合作为低门槛获客和声乐课承接活动。",
      highlights: ["大字歌单", "副歌高光录制", "活动后群内作品发布"],
      schedule: [
        { time: "14:00", item: "签到点歌与分组" },
        { time: "14:30", item: "怀旧金曲接龙" },
        { time: "16:20", item: "合唱收尾与合影" }
      ],
      plan: {
        target: "筛选声乐兴趣用户，沉淀愿意参与合唱或课程的高活跃人群。",
        materials: "大字歌单、麦克风、补光灯、手机稳定器。",
        staffing: "1名主理人、1名控场主持、1名拍摄人员。",
        conversion: "活动后24小时内发布个人唱段，邀约7天唱歌陪练营。",
        risk: "控制音量和时长，避免劝酒，提醒用户注意台阶和动线。"
      },
      videos: [],
      references: []
    }
  ];
  content.innerHTML = `
    <div class="topbar">
      <div>
        <h1>导入审核</h1>
        <p>用于承接小程序招募活动、城市活动提报或外部表单导出，导入后默认进入待审核池。</p>
      </div>
    </div>
    ${state.message}
    <div class="grid">
      <section class="panel">
        <h2>批量导入活动</h2>
        <form id="importForm">
          <div class="field">
            <label>导入来源</label>
            <input class="input" name="importSource" value="小程序招募活动导出">
          </div>
          <div class="field">
            <label>JSON 内容</label>
            <textarea class="textarea import-textarea" name="payload" placeholder="粘贴活动数组，或 { activities: [...] }">${esc(JSON.stringify(sample, null, 2))}</textarea>
            <span class="help">字段可包含：title、city、region、category、activityType、price、capacity、duration、location、intro、highlights、schedule、plan、images、videos、references。</span>
          </div>
          <button class="btn" type="submit">导入到待审核</button>
        </form>
      </section>
      <section class="panel">
        <h2>审核工作台</h2>
        <table class="table">
          <thead>
            <tr>
              <th>活动</th>
              <th>地区</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${state.activities.filter(x => x.status !== "published").map(activity => `
              <tr>
                <td>${esc(activity.title)}</td>
                <td>${esc(activity.region || activity.city || "待补充")}</td>
                <td><span class="status${statusClass(activity.status)}">${statusLabel(activity.status)}</span></td>
                <td><button class="mini-btn" data-edit-import="${esc(activity.id)}">编辑审核</button></td>
              </tr>
            `).join("") || `<tr><td colspan="4">暂无待审核活动</td></tr>`}
          </tbody>
        </table>
      </section>
    </div>
  `;
  document.querySelector("#importForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const raw = JSON.parse(form.get("payload"));
      const activities = Array.isArray(raw) ? raw : raw.activities;
      const data = await api("/api/admin/import-activities", {
        method: "POST",
        body: {
          importSource: form.get("importSource"),
          activities
        }
      });
      await refreshData();
      flash(`导入完成：新增 ${data.created} 个，更新 ${data.updated} 个，跳过 ${data.skipped} 个。`);
      renderImport();
    } catch (err) {
      flash(err.message, "error");
      renderImport();
    }
  });
  document.querySelectorAll("[data-edit-import]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.editingId = btn.dataset.editImport;
      state.activeTab = "activities";
      clearFlash();
      renderShell();
    });
  });
}

function renderPreview() {
  const content = document.querySelector("#content");
  content.innerHTML = `
    <div class="topbar">
      <div>
        <h1>前台入口</h1>
        <p>把这些链接发给主理人、合作伙伴或用户，即可查看活动展示页。</p>
      </div>
      <a class="btn" href="/" target="_blank">打开H5首页</a>
    </div>
    <section class="panel">
      <h2>可复制链接</h2>
      <table class="table">
        <thead>
          <tr>
            <th>活动</th>
            <th>状态</th>
            <th>链接</th>
          </tr>
        </thead>
        <tbody>
          ${state.activities.map(activity => `
            <tr>
              <td>${esc(activity.title)}</td>
              <td><span class="status${statusClass(activity.status)}">${statusLabel(activity.status)}</span></td>
              <td><a class="mini-btn" href="/activity/${encodeURIComponent(activity.id)}" target="_blank">打开详情页</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function renderUsers() {
  const content = document.querySelector("#content");
  content.innerHTML = `
    <div class="topbar">
      <div>
        <h1>账号权限</h1>
        <p>总部管理员可以创建学习用户、城市主理人、只读账号，并控制普通用户是否可下载 SOP。</p>
      </div>
    </div>
    ${state.message}
    <div class="grid">
      <section class="panel">
        <h2>创建账号</h2>
        <form id="createUserForm">
          <div class="field">
            <label>账号</label>
            <input class="input" name="username" placeholder="例如 shanghai01">
          </div>
          <div class="field">
            <label>姓名/昵称</label>
            <input class="input" name="name" placeholder="例如 上海主理人">
          </div>
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
            <div class="field">
              <label>初始密码</label>
              <input class="input" name="password" placeholder="至少6位">
            </div>
          </div>
          <label class="checkline">
            <input type="checkbox" name="canDownload" checked>
            <span>允许下载 SOP</span>
          </label>
          <button class="btn" type="submit">创建账号</button>
        </form>
      </section>
      <section class="panel">
        <h2>账号列表</h2>
        <table class="table">
          <thead>
            <tr>
              <th>账号</th>
              <th>名称</th>
              <th>角色</th>
              <th>状态</th>
              <th>SOP下载</th>
              <th>新密码</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${state.users.map(user => `
              <tr data-user-row="${esc(user.id)}">
                <td>${esc(user.username)}</td>
                <td><input class="input" data-user-name value="${esc(user.name)}"></td>
                <td>
                  <select class="select" data-user-role>
                    <option value="admin" ${user.role === "admin" ? "selected" : ""}>总部管理员</option>
                    <option value="operator" ${user.role === "operator" ? "selected" : ""}>城市主理人</option>
                    <option value="viewer" ${user.role === "viewer" ? "selected" : ""}>只读账号</option>
                    <option value="member" ${user.role === "member" ? "selected" : ""}>普通学习用户</option>
                  </select>
                </td>
                <td>
                  <select class="select" data-user-status>
                    <option value="active" ${user.status === "active" ? "selected" : ""}>启用</option>
                    <option value="disabled" ${user.status === "disabled" ? "selected" : ""}>停用</option>
                  </select>
                </td>
                <td>
                  <select class="select" data-user-download>
                    <option value="true" ${user.canDownload ? "selected" : ""}>允许</option>
                    <option value="false" ${user.canDownload ? "" : "selected"}>禁止</option>
                  </select>
                </td>
                <td><input class="input" data-user-password placeholder="不改留空"></td>
                <td>
                  <div class="mini-actions">
                    <button class="mini-btn" data-save-user="${esc(user.id)}">保存</button>
                    ${user.id !== state.user.id ? `<button class="mini-btn" data-delete-user="${esc(user.id)}">删除</button>` : ""}
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
    </div>
  `;
  bindUserEvents();
}

function bindUserEvents() {
  document.querySelector("#createUserForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: {
          username: form.get("username"),
          name: form.get("name"),
          role: form.get("role"),
          password: form.get("password"),
          canDownload: form.get("canDownload") === "on"
        }
      });
      await refreshData();
      flash("账号已创建");
      renderUsers();
    } catch (err) {
      flash(err.message, "error");
      renderUsers();
    }
  });
  document.querySelectorAll("[data-save-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = document.querySelector(`[data-user-row="${CSS.escape(btn.dataset.saveUser)}"]`);
      try {
        await api(`/api/admin/users/${encodeURIComponent(btn.dataset.saveUser)}`, {
          method: "PUT",
          body: {
            name: row.querySelector("[data-user-name]").value,
            role: row.querySelector("[data-user-role]").value,
            status: row.querySelector("[data-user-status]").value,
            canDownload: row.querySelector("[data-user-download]").value === "true",
            password: row.querySelector("[data-user-password]").value
          }
        });
        await refreshData();
        flash("账号已更新");
        renderUsers();
      } catch (err) {
        flash(err.message, "error");
        renderUsers();
      }
    });
  });
  document.querySelectorAll("[data-delete-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除这个账号吗？")) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(btn.dataset.deleteUser)}`, { method: "DELETE" });
        await refreshData();
        flash("账号已删除");
        renderUsers();
      } catch (err) {
        flash(err.message, "error");
        renderUsers();
      }
    });
  });
}

async function boot() {
  try {
    const data = await api("/api/me");
    if (!data.user) {
      showLogin();
      return;
    }
    state.user = data.user;
    await refreshData();
    renderShell();
  } catch {
    showLogin();
  }
}

boot();
