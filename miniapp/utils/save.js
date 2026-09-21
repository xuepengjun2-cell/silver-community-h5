const { getProject, recordDownloadIntent } = require("./api");
const { saveEligibility, saveSource, trustedMediaUrl } = require("./album");

function downloadFile(wxApi, url, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wxApi.downloadFile({
      url,
      success(result) {
        if (result.statusCode !== 200 || !result.tempFilePath) {
          return reject(new Error("视频或照片下载未完成，请稍后重试。"));
        }
        resolve(result.tempFilePath);
      },
      fail(error) {
        const detail = String(error && error.errMsg || "");
        reject(new Error(/exceed|limit|200\s*mb|too large/i.test(detail)
          ? "视频超过微信单次下载限制，请主办方上传小于 200 MB 的 MP4 版本。"
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

function saveLocalFile(wxApi, type, filePath) {
  return new Promise((resolve, reject) => {
    const method = type === "video" ? "saveVideoToPhotosAlbum" : "saveImageToPhotosAlbum";
    wxApi[method]({ filePath, success: resolve, fail: reject });
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

async function saveMedia(wxApi, { projectId, index, media, onProgress }) {
  const eligibility = saveEligibility(media);
  if (!eligibility.ok) throw new Error(eligibility.reason);
  // 保存前再次读取公开相册：下架、关闭分享、删素材后不继续下载。
  const project = await getProject(wxApi, projectId);
  const fresh = Array.isArray(project.media) ? project.media[index] : null;
  if (!fresh || fresh.type !== media.type || fresh.url !== media.url ||
      saveSource(fresh).url !== saveSource(media).url || !saveEligibility(fresh).ok) {
    throw new Error("素材已更新，请返回相册重新打开。");
  }
  // 现有服务端按这个接口记录下载。不能直接用其签名 TOS 地址下载：
  // 个人小程序只配置我们可验证的 CDN 域名，避免跨域重定向失败。
  await recordDownloadIntent(wxApi, projectId, index, fresh.type);
  const url = trustedMediaUrl(saveSource(fresh));
  let tempFilePath = "";
  try {
    tempFilePath = await downloadFile(wxApi, url, onProgress);
    try {
      await saveLocalFile(wxApi, fresh.type, tempFilePath);
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      if (!await askForAlbumAccess(wxApi)) throw new Error("未取得相册权限，尚未保存。您可以稍后再试。");
      await saveLocalFile(wxApi, fresh.type, tempFilePath);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("保存失败，请检查相册权限和手机剩余空间后再试。");
  } finally {
    cleanTempFile(wxApi, tempFilePath);
  }
}

module.exports = { downloadFile, isPermissionDenied, saveMedia };
