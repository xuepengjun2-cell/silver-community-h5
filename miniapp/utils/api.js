const config = require("../config");
const { parseAlbumOptions } = require("./album");

function request(wxApi, path) {
  return new Promise((resolve, reject) => {
    wxApi.request({
      url: `${config.apiBase}${path}`,
      method: "GET",
      header: { Accept: "application/json" },
      success(response) {
        const data = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(data);
        reject(new Error(response.statusCode === 404
          ? "相册未发布、已关闭分享，或素材已被移除。"
          : data.error || "相册暂时无法打开，请稍后再试。"));
      },
      fail() { reject(new Error("网络连接失败，请检查网络后重试。")); }
    });
  });
}

async function getProject(wxApi, id) {
  if (!parseAlbumOptions({ id })) throw new Error("相册编号无效");
  const data = await request(wxApi, `/public/activity-projects/${id}`);
  if (!data.project || data.project.id !== id) throw new Error("相册数据不完整，请稍后重试。");
  return data.project;
}

async function recordDownloadIntent(wxApi, id, index, expectedType) {
  if (!parseAlbumOptions({ id, i: String(index) })) throw new Error("素材编号无效");
  const data = await request(wxApi, `/public/activity-projects/${id}/download?i=${index}`);
  if (data.type !== expectedType || !data.url) throw new Error("素材信息已变化，请返回相册重新打开。");
  // 现有接口会复核公开状态并记录下载统计。返回的是短时效 TOS 地址，
  // 小程序实际下载使用公开的同源 CDN 地址，避免重定向到未登记的 TOS 域名。
  return data;
}

module.exports = { request, getProject, recordDownloadIntent };
