// PM2 生产进程配置
// 生产代码必须从 GitHub 明确 commit 构建后发布；服务器目录不是编辑源。
const fs = require("fs");
const env = { NODE_ENV: "production" };

try {
  fs.readFileSync("/etc/silver-community.env", "utf8")
    .split("\n")
    .forEach((line) => {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match) env[match[1]] = match[2];
    });
} catch (error) {
  // 本地运行没有生产环境文件时使用默认环境。
}

module.exports = {
  apps: [
    {
      name: "silver",
      cwd: "/var/www/silver-community-h5",
      script: "server.js",
      interpreter: "/usr/local/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      min_uptime: "10s",
      max_restarts: 50,
      restart_delay: 3000,
      env,
      out_file: "/var/www/silver-community-h5/logs/out.log",
      error_file: "/var/www/silver-community-h5/logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true
    }
  ]
};
