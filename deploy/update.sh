#!/usr/bin/env bash
# 代码更新脚本 · 每次 GitHub 推送后在服务器上执行
# 使用：bash /opt/kaikai-sop/deploy/update.sh

set -euo pipefail

APP_DIR="/opt/kaikai-sop"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始更新..."

cd "$APP_DIR"

# 拉取最新代码
git pull origin main

# 重启应用（zero-downtime：PM2 reload 不中断现有连接）
pm2 reload kaikai-sop

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 更新完成，当前版本："
git log --oneline -3
pm2 list
