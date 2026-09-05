#!/usr/bin/env bash
# =====================================================
#  开开华彩 SOP 平台 · 服务器一键初始化部署脚本
#  适用系统：Ubuntu 22.04
#  使用方式：在 ECS 服务器上以 root 执行
#    curl -o deploy.sh https://raw.githubusercontent.com/xuepengjun2-cell/silver-community-h5/main/deploy/setup.sh
#    chmod +x deploy.sh && sudo bash deploy.sh <GitHub commit SHA>
#  注意：该脚本仅用于新服务器初始化；现有生产更新必须走 DEPLOYMENT.md 的受控发布流程。
# =====================================================

set -euo pipefail

REPO_URL="https://github.com/xuepengjun2-cell/silver-community-h5.git"
APP_DIR="/var/www/silver-community-h5"
APP_USER="silver"
NODE_VERSION="20"
TARGET_COMMIT="${1:-}"

if [[ -z "$TARGET_COMMIT" || ! "$TARGET_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    echo "用法：$0 <GitHub commit SHA>" >&2
    exit 2
fi

echo "================================================"
echo " 开开华彩 SOP 平台 · 部署开始"
echo "================================================"

# ---- 1. 系统更新 ----
echo "[1/8] 更新系统软件包..."
apt-get update -qq && apt-get upgrade -y -qq

# ---- 2. 安装 Node.js ----
echo "[2/8] 安装 Node.js $NODE_VERSION..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
fi
echo "Node.js 版本：$(node -v)"

# ---- 3. 安装 PM2 + Nginx ----
echo "[3/8] 安装 PM2 和 Nginx..."
npm install -g pm2 --quiet
apt-get install -y nginx git

# ---- 4. 创建应用用户 ----
echo "[4/8] 创建应用用户 $APP_USER..."
if ! id "$APP_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$APP_USER"
fi

# ---- 5. 拉取代码 ----
echo "[5/8] 从 GitHub 拉取代码..."
if [ -d "$APP_DIR/.git" ]; then
    echo "  已存在 Git 工作树，按明确 commit 更新..."
    cd "$APP_DIR" && git fetch origin "$TARGET_COMMIT" && git checkout --detach "$TARGET_COMMIT"
else
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR" && git checkout --detach "$TARGET_COMMIT"
fi

# 创建必要目录（不在 Git 里的）
mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/uploads"
mkdir -p "$APP_DIR/logs"
mkdir -p "$APP_DIR/backups"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ---- 6. 初始化数据（首次部署才执行）----
echo "[6/8] 初始化数据..."
if [ ! -f "$APP_DIR/data/db.json" ]; then
    echo "  首次部署，初始化 db.json..."
    # db.json 从 seed 生成，server.js 启动时会自动处理
    echo "  db.json 将在首次启动时自动创建"
fi

# ---- 7. 配置 Nginx ----
echo "[7/8] 配置 Nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/kaikai-sop
ln -sf /etc/nginx/sites-available/kaikai-sop /etc/nginx/sites-enabled/kaikai-sop
# 删除默认站点
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
systemctl enable nginx

# ---- 8. 启动应用 ----
echo "[8/8] 用 PM2 启动应用..."
cd "$APP_DIR"
pm2 delete silver 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 | bash || true

# ---- 设置备份 cron ----
echo "设置每日自动备份..."
chmod +x "$APP_DIR/deploy/backup.sh"
CRON_JOB="0 2 * * * $APP_DIR/deploy/backup.sh >> $APP_DIR/logs/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v "backup.sh"; echo "$CRON_JOB") | crontab -

echo ""
echo "================================================"
echo " 部署完成！"
echo "================================================"
echo ""
echo " 服务状态：pm2 list"
echo " 查看日志：pm2 logs silver"
echo " 前台访问：http://$(curl -s ifconfig.me)"
echo " 后台地址：http://$(curl -s ifconfig.me)/admin"
echo ""
echo " 下一步："
echo "   1. 编辑 /etc/nginx/sites-available/kaikai-sop"
echo "      把 server_name 改成你的域名"
echo "   2. 配置 SSL 证书："
echo "      apt install certbot python3-certbot-nginx"
echo "      certbot --nginx -d your-domain.com"
echo "================================================"
