const { transferTimeoutMs } = require("../config");
const { getProject, recordDownloadIntent } = require("./api");
const { saveEligibility, trustedMediaUrl } = require("./album");
const { privacyErrorMessage, isTimeout } = require("./errors");
const { photoUrl, fileExtension } = require("./catalog");

function downloadablePhotoUrl(url) {
  return /^(?:jpe?g|png)$/i.test(fileExtension(url)) ? photoUrl(url) : "";
}

function downloadFile(wxApi, url, onProgress) {
  const source = downloadablePhotoUrl(url);
  if (!source) return Promise.reject(new Error("这个图片地址在本小程序中不可用。"));
  return new Promise((resolve, reject) => {
    const task = wxApi.downloadFile({
      url: source,
      timeout: transferTimeoutMs,
      success(result) {
        if (result.statusCode !== 200 || !result.tempFilePath) {
          return reject(new Error("照片下载未完成，请稍后重试。"));
        }
        resolve(result.tempFilePath);
      },
      fail(error) {
        reject(new Error(isTimeout(error)
          ? "网络较慢，下载超时。请连接 Wi-Fi 后重试。"
          : "下载失败，请检查网络或稍后重试。"));
      }
    });
    if (task && typeof task.onProgressUpdate === "function") {
      task.onProgressUpdate(info => {
        if (typeof onProgress === "function") onProgress(Math.max(0, Math.min(100, Number(info.progress) || 0)));
      });
    }
  });
}

function saveLocalFile(wxApi, filePath) {
  return new Promise((resolve, reject) => {
    wxApi.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject });
  });
}

function isPermissionDenied(error) {
  return /auth deny|authorize no response|permission denied|auth.*denied/i.test(String(error && (error.errMsg || error.message) || ""));
}

function askForAlbumAccess(wxApi) {
  return new Promise(resolve => {
    wxApi.showModal({
      title: "需要保存到相册的权限",
      content: "请在小程序设置中允许“添加到相册”，然后继续保存。",
      confirmText: "去设置",
      success(modal) {
        if (!modal.confirm) return resolve(false);
        wxApi.openSetting({
          success(setting) { resolve(setting.authSetting && setting.authSetting["scope.writePhotosAlbum"] === true); },
          fail() { resolve(false); }
        });
      },
      fail() { resolve(false); }
    });
  });
}

function cleanTempFile(wxApi, filePath) {
  if (!filePath || typeof wxApi.getFileSystemManager !== "function") return;
  try { wxApi.getFileSystemManager().unlink({ filePath, fail() {} }); } catch (_) { /* 临时文件会由微信回收 */ }
}

async function saveDownloadedMedia(wxApi, type, url, onProgress) {
  // 调用方先复核相册或案例权限；此层仍拒绝所有非图片及伪装扩展。
  if (type !== "image" || !downloadablePhotoUrl(url)) throw new Error("这个素材在本小程序中不可用，请选择 JPG 或 PNG 照片。");
  let tempFilePath = "";
  try {
    tempFilePath = await downloadFile(wxApi, url, onProgress);
    try {
      await saveLocalFile(wxApi, tempFilePath);
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      if (!await askForAlbumAccess(wxApi)) throw new Error("未取得相册权限，尚未保存。您可以稍后再试。");
      await saveLocalFile(wxApi, tempFilePath);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(privacyErrorMessage(error) || "保存失败，请检查相册权限和手机剩余空间后再试。");
  } finally {
    cleanTempFile(wxApi, tempFilePath);
  }
}

async function saveMedia(wxApi, { projectId, index, media, onProgress }) {
  const eligibility = saveEligibility(media);
  if (!eligibility.ok) throw new Error(eligibility.reason);
  // 保存前再次读取公开相册：下架、关闭分享、删素材后不继续下载。
  const project = await getProject(wxApi, projectId);
  const fresh = Array.isArray(project.media) ? project.media[index] : null;
  if (!fresh || fresh.type !== media.type || fresh.url !== media.url ||
      !saveEligibility(fresh).ok) {
    throw new Error("素材已更新，请返回相册重新打开。");
  }
  // 现有服务端按这个接口记录下载。不能直接用其签名 TOS 地址下载：
  // 个人小程序只配置我们可验证的 CDN 域名，避免重定向到未登记的 TOS 域名。
  await recordDownloadIntent(wxApi, projectId, index, fresh.type);
  await saveDownloadedMedia(wxApi, fresh.type, trustedMediaUrl(fresh), onProgress);
}

module.exports = { downloadFile, isPermissionDenied, saveDownloadedMedia, saveMedia };
