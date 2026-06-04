// PM2 生产进程配置
// 使用：pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "kaikai-sop",           // 进程名，pm2 list 里看到的名字
      script: "server.js",
      cwd: "/opt/kaikai-sop",       // 服务器上的项目目录，按实际修改
      instances: 1,                  // 单实例，JSON文件存储不支持多进程并发写
      autorestart: true,             // 崩溃自动重启
      watch: false,                  // 生产环境关闭文件监听
      max_memory_restart: "400M",    // 内存超限自动重启
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      // 日志
      out_file: "/opt/kaikai-sop/logs/out.log",
      error_file: "/opt/kaikai-sop/logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true
    }
  ]
};
