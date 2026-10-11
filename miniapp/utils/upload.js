const config = require("../config");
const { api } = require("./auth");
const { isTimeout } = require("./errors");

const MAX_IMAGE = 50 * 1024 * 1024;
const MAX_VIDEO = 190 * 1024 * 1024;

function callWx(wxApi, method, options) {
  return new Promise((resolve, reject) => wxApi[method]({
    ...options,
    success: resolve,
    fail: error => reject(new Error(error.errMsg || "文件处理失败，请重试。"))
  }));
}

async function prepareMedia(wxApi, source, type) {
  if (type === "image") {
    const result = await callWx(wxApi, "compressImage", { src: source, quality: 75 });
    const info = await callWx(wxApi, "getFileInfo", { filePath: result.tempFilePath });
    if (!info.size || info.size > MAX_IMAGE) throw new Error("图片压缩后仍超过 50 MB，请选择更小的照片。");
    return { path: result.tempFilePath, size: info.size };
  }
  // 客户端先压缩以降低流量；最终格式、编码和大小仍由服务端验证/转为 MP4。
  const result = await callWx(wxApi, "compressVideo", { src: source, quality: "medium" });
  const info = await callWx(wxApi, "getFileInfo", { filePath: result.tempFilePath });
  if (!info.size || info.size >= MAX_VIDEO) throw new Error("压缩后仍达到上传限额，请分段上传这段视频。成片须小于 200 MB，后台预留处理余量，不会上传原片。");
  return { path: result.tempFilePath, size: info.size };
}

function uploadFile(wxApi, { projectId, type, path, token, onProgress }) {
  return new Promise((resolve, reject) => {
    const task = wxApi.uploadFile({
      url: `${config.apiBase}/my/activity-projects/${projectId}/miniapp-media?type=${type}`,
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
          ? "网络较慢，上传超时。请连接 Wi-Fi 后重试，较长的视频请分段上传。"
          : error.errMsg || "上传中断，请检查网络。"));
      }
    });
    if (task && typeof task.onProgressUpdate === "function") task.onProgressUpdate(progress => onProgress(progress.progress));
  });
}

async function uploadMedia(wxApi, { projectId, source, type, token, onProgress = () => {}, onStage = () => {}, isCancelled = () => false }) {
  onStage("preparing");
  const prepared = await prepareMedia(wxApi, source, type);
  if (isCancelled()) throw new Error("已离开上传页面，本次素材尚未上传，请重新选择。");
  onStage("uploading");
  const result = await uploadFile(wxApi, { projectId, type, path: prepared.path, token, onProgress });
  if (type === "image") return result;
  if (!result.jobId) throw new Error("视频未获得处理编号，请联系管理员核查。") ;
  return result;
}

function getVideoJob(wxApi, { projectId, jobId, token }) {
  return api(wxApi, `/my/activity-projects/${projectId}/miniapp-media/${jobId}`, { token });
}

function retryVideoJob(wxApi, { projectId, jobId, token }) {
  return api(wxApi, `/my/activity-projects/${projectId}/miniapp-media/${jobId}/retry`, { method: "POST", token });
}

module.exports = { MAX_IMAGE, MAX_VIDEO, prepareMedia, uploadMedia, getVideoJob, retryVideoJob };
