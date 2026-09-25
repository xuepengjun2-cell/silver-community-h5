// 通过 `node --require` 预加载：把 MySQL 换成内存版，把 FFmpeg 处理换成文件拷贝，
// 让上传、转码队列、写回路径在没有数据库和 FFmpeg 的开发机上也能跑通。
const Module = require("module");
const fs = require("fs");
const fakeMysql = require("./fake-mysql");

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
