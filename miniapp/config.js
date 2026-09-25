// 仅允许当前银发活动相册的公开 API 与 CDN；不要在小程序包内放 AppSecret 或 TOS 密钥。
module.exports = {
  apiBase: "https://apip2.kkhuacai08.cn/silver-api",
  imageBase: "https://proj2.likeduoduiyi.cn/silver-project-images/",
  videoBase: "https://proj2.likeduoduiyi.cn/silver-project-videos/",
  // 上传/下载大视频的超时。微信默认 60 秒，190 MB 需持续约 25 Mbps 才能完成；与 app.json networkTimeout 一致。
  transferTimeoutMs: 10 * 60 * 1000
};
