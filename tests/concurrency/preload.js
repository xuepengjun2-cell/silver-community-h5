// 通过 `node --require` 预加载：把 MySQL 换成内存版，把 FFmpeg 处理换成文件拷贝，
// 让上传、转码队列、写回路径在没有数据库和 FFmpeg 的开发机上也能跑通。
const Module = require("module");
const fs = require("fs");
const fakeMysql = require("./fake-mysql");

if (process.env.FAKE_WECHAT_CODES) {
  const codes = JSON.parse(process.env.FAKE_WECHAT_CODES);
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.weixin.qq.com" && url.pathname === "/sns/jscode2session") {
      const gateFile = process.env.FAKE_WECHAT_GATE_FILE;
      if (gateFile && fs.existsSync(gateFile)) {
        const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
        if (gate.code === url.searchParams.get("js_code")) {
          fs.writeFileSync(gate.enteredFile, "entered");
          for (let attempt = 0; attempt < 1600 && !fs.existsSync(gate.releaseFile); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          if (!fs.existsSync(gate.releaseFile)) throw new Error("fake-wechat: test gate was not released");
        }
      }
      const openid = codes[url.searchParams.get("js_code")];
      return new Response(JSON.stringify(openid ? { openid, session_key: "server-only-test" } : { errcode: 40029 }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(input, options);
  };
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "mysql2/promise") return fakeMysql;
  const loaded = originalLoad.apply(this, arguments);
  if (/server[\\/]miniapp-media$/.test(request) && !loaded.__harness) {
    const copy = async (source, target) => { fs.copyFileSync(source, target); return fs.statSync(target).size; };
    loaded.processImage = copy;
    loaded.processVideo = copy;
    loaded.processVideoPoster = async (_video, target) => { fs.writeFileSync(target, Buffer.alloc(2048, 7)); return 2048; };
    loaded.__harness = true;
  }
  return loaded;
};
