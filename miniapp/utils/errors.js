// 微信隐私接口失败：112 = 小程序后台《用户隐私保护指引》未声明该接口；
// 104 = 用户没有同意隐私保护指引。两者都不是“相册权限被拒绝”，需要单独说明。
function privacyErrorMessage(error) {
  const errno = Number(error && error.errno);
  const detail = String(error && (error.errMsg || error.message) || "");
  if (errno === 112 || /not declared in the privacy agreement/i.test(detail)) {
    return "小程序尚未在微信后台声明此项权限（用户隐私保护指引），暂时无法使用。";
  }
  if (errno === 104 || /privacy permission is not authorized/i.test(detail)) {
    return "需要先同意小程序的隐私保护指引才能继续，请重试并点击“同意”。";
  }
  return "";
}

function isTimeout(error) {
  return /timeout|timed out/i.test(String(error && (error.errMsg || error.message) || ""));
}

module.exports = { privacyErrorMessage, isTimeout };
