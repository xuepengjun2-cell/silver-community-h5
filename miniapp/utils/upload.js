const config = require("../config");
const { isTimeout } = require("./errors");

const MAX_IMAGE = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|gif|bmp|heic|heif)$/i;

function requireImage(type) {
  if (type !== "image") throw new Error("本小程序仅支持上传照片。");
}

function isImageSelection(file) {
  if (!file || typeof file.tempFilePath !== "string" || !file.tempFilePath.trim()) return false;
  if (file.fileType !== undefined && file.fileType !== "image") return false;
  const source = file.tempFilePath.split(/[?#]/)[0];
  if (/\.[a-z0-9]+$/i.test(source)) return IMAGE_EXTENSIONS.test(source);
  // 微信临时文件可能不带扩展名，此时必须由选择器确认类型；实际格式再由图片压缩 API 验证。
  return file.fileType === "image";
}

function callWx(wxApi, method, options) {
  return new Promise((resolve, reject) => wxApi[method]({
    ...options,
    success: resolve,
    fail: error => reject(new Error(error.errMsg || "文件处理失败，请重试。"))
  }));
}

async function prepareMedia(wxApi, source, type) {
  requireImage(type);
  if (typeof source !== "string" || !source.trim()) throw new Error("照片文件无效，请重新选择。");
  const result = await callWx(wxApi, "compressImage", { src: source, quality: 75 });
  if (typeof result.tempFilePath !== "string" || !result.tempFilePath) throw new Error("照片压缩失败，请重新选择。");
  const info = await callWx(wxApi, "getFileInfo", { filePath: result.tempFilePath });
  if (!Number.isFinite(info.size) || info.size <= 0 || info.size > MAX_IMAGE) throw new Error("图片压缩后仍超过 50 MB 或文件无效，请选择更小的照片。");
  return { path: result.tempFilePath, size: info.size };
}

function uploadFile(wxApi, { projectId, path, token, onProgress }) {
  return new Promise((resolve, reject) => {
    const task = wxApi.uploadFile({
      url: `${config.apiBase}/my/activity-projects/${projectId}/miniapp-media?type=image`,
      filePath: path,
      name: "media",
      timeout: config.transferTimeoutMs,
      header: { Authorization: `Bearer ${token}` },
      success(response) {
        let data;
        try { data = JSON.parse(response.data || "{}"); }
        catch { return reject(new Error("上传服务响应异常，请稍后重试。")); }
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(data);
        reject(new Error(data.error || (response.statusCode === 404 ? "上传服务尚未上线，请稍后重试。" : "上传失败，请重试。")));
      },
      fail(error) {
        reject(new Error(isTimeout(error)
          ? "网络较慢，照片上传超时。请连接 Wi-Fi 后重试。"
          : error.errMsg || "上传中断，请检查网络。"));
      }
    });
    if (task && typeof task.onProgressUpdate === "function") task.onProgressUpdate(progress => onProgress(progress.progress));
  });
}

async function uploadMedia(wxApi, { projectId, source, type, token, onProgress = () => {}, onStage = () => {}, isCancelled = () => false }) {
  requireImage(type);
  if (isCancelled()) throw new Error("已离开上传页面，请重新选择照片。");
  onStage("preparing");
  const prepared = await prepareMedia(wxApi, source, type);
  if (isCancelled()) throw new Error("已离开上传页面，本次素材尚未上传，请重新选择。");
  onStage("uploading");
  return uploadFile(wxApi, { projectId, path: prepared.path, token, onProgress });
}

module.exports = { MAX_IMAGE, isImageSelection, prepareMedia, uploadMedia };
