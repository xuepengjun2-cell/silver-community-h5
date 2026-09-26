const config = require("../config");
const { api, getSession } = require("./auth");
const { mediaUrl } = require("./urls");
const { saveDownloadedMedia } = require("./save");
const { isTimeout } = require("./errors");

function loggedIn(wxApi) {
  const session = getSession(wxApi);
  if (!session) throw new Error("请先登录主办方账号，再下载活动资料。");
  return session;
}

function downloadPdf(wxApi, id, token, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wxApi.downloadFile({
      url: `${config.apiBase}/public/activities/${encodeURIComponent(id)}/download.pdf`,
      header: { Authorization: `Bearer ${token}` },
      timeout: config.transferTimeoutMs,
      success(result) {
        if (result.statusCode === 401) return reject(new Error("登录已过期，请重新登录后下载。"));
        if (result.statusCode === 403) return reject(new Error("该活动暂未开放 SOP 下载，或账号无下载权限。"));
        if (result.statusCode !== 200 || !result.tempFilePath) return reject(new Error("PDF 生成失败，请稍后重试。"));
        resolve(result.tempFilePath);
      },
      fail(error) { reject(new Error(isTimeout(error) ? "PDF 下载超时，请连接 Wi-Fi 后重试。" : "PDF 下载失败，请检查网络后重试。")); }
    });
    if (task && typeof task.onProgressUpdate === "function" && typeof onProgress === "function") {
      task.onProgressUpdate(info => onProgress(Math.max(0, Math.min(100, Number(info.progress) || 0))));
    }
  });
}

function saveFile(wxApi, tempFilePath) {
  return new Promise((resolve, reject) => wxApi.saveFile({
    tempFilePath,
    success(result) { result.savedFilePath ? resolve(result.savedFilePath) : reject(new Error("PDF 未能保存到小程序，请检查手机剩余空间。")); },
    fail() { reject(new Error("PDF 未能保存到小程序，请检查手机剩余空间。")); }
  }));
}

function openDocument(wxApi, filePath, fileType) {
  return new Promise((resolve, reject) => wxApi.openDocument({
    filePath, fileType, showMenu: true,
    success: resolve,
    fail() { reject(new Error("文件已下载，但暂时无法打开。请稍后重试。")); }
  }));
}

async function openSopPdf(wxApi, id, onProgress) {
  const { token } = loggedIn(wxApi);
  const temp = await downloadPdf(wxApi, id, token, onProgress);
  const saved = await saveFile(wxApi, temp);
  await openDocument(wxApi, saved, "pdf");
  return saved;
}

async function saveCaseMedia(wxApi, caseId, media, onProgress) {
  const { token } = loggedIn(wxApi);
  if (!media || !["image", "video"].includes(media.type) || !Number.isSafeInteger(media.index)) {
    throw new Error("该素材暂不支持保存到相册。");
  }
  // 下载授权与审计由服务端完成；分享卡片和图片预览不提升下载权限。
  const result = await api(wxApi, `/public/cases/${encodeURIComponent(caseId)}/download?i=${media.index}&format=json`, { token });
  const url = mediaUrl(result.url);
  if (!url || url !== media.url) throw new Error("素材已更新，请刷新案例后重试。");
  if (media.type === "video" && !/\.mp4(?:\?|$)/i.test(url)) throw new Error("该视频还没有可保存的 MP4 版本，请联系主办方。");
  if (media.type === "image" && !/\.(?:jpe?g|png)(?:\?|$)/i.test(url)) throw new Error("这张图片暂不支持保存到相册。");
  await saveDownloadedMedia(wxApi, media.type, url, onProgress);
}

async function openCaseDocument(wxApi, caseId, media, onProgress) {
  const { token } = loggedIn(wxApi);
  if (!media || media.type !== "document" || !Number.isSafeInteger(media.index)) throw new Error("文档编号无效。");
  const result = await api(wxApi, `/public/cases/${encodeURIComponent(caseId)}/download?i=${media.index}&format=json`, { token });
  const url = mediaUrl(result.url);
  if (!url || url !== media.url) throw new Error("文档已更新，请刷新案例后重试。");
  const ext = (url.split("?")[0].match(/\.(pdf|docx?|pptx?|xlsx?)$/i) || [])[1];
  if (!ext) throw new Error("该文档格式暂不支持在小程序中打开。");
  const temp = await new Promise((resolve, reject) => {
    const task = wxApi.downloadFile({
      url, timeout: config.transferTimeoutMs,
      success(file) { file.statusCode === 200 && file.tempFilePath ? resolve(file.tempFilePath) : reject(new Error("文档下载失败，请稍后重试。")); },
      fail() { reject(new Error("文档下载失败，请检查网络后重试。")); }
    });
    if (task && typeof task.onProgressUpdate === "function" && typeof onProgress === "function") {
      task.onProgressUpdate(info => onProgress(Math.max(0, Math.min(100, Number(info.progress) || 0))));
    }
  });
  const saved = await saveFile(wxApi, temp);
  await openDocument(wxApi, saved, ext.toLowerCase());
  return saved;
}

module.exports = { openSopPdf, saveCaseMedia, openCaseDocument };
