#!/usr/bin/env bash
# 数据自动备份脚本
# 每天凌晨2点运行（通过 cron 设置）
# crontab -e 加入：0 2 * * * /var/www/silver-community-h5/deploy/backup.sh >> /var/www/silver-community-h5/logs/backup.log 2>&1

set -euo pipefail

PROJECT_DIR="/var/www/silver-community-h5"
BACKUP_DIR="$PROJECT_DIR/backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/backup_$DATE.tar.gz"
KEEP_DAYS=14    # 本地保留14天备份

mkdir -p "$BACKUP_DIR"
mkdir -p "$PROJECT_DIR/logs"

echo "[$DATE] 开始备份..."

# 打包 data/ 和 uploads/
tar -czf "$BACKUP_FILE" \
    -C "$PROJECT_DIR" \
    data/ \
    uploads/ \
    2>/dev/null || true

echo "[$DATE] 备份文件：$BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"

# 清理超过 KEEP_DAYS 天的旧备份
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +$KEEP_DAYS -delete
echo "[$DATE] 已清理 $KEEP_DAYS 天前的旧备份"

# -------------------------------------------------------
# 可选：上传备份到火山引擎 TOS 对象存储
# 需要先安装 tos 命令行工具并配置 AccessKey
# -------------------------------------------------------
# TOS_BUCKET="your-bucket-name"
# TOS_PATH="tos://$TOS_BUCKET/kaikai-sop-backups/backup_$DATE.tar.gz"
# if command -v tosutil &> /dev/null; then
#     tosutil cp "$BACKUP_FILE" "$TOS_PATH"
#     echo "[$DATE] 已上传到 TOS: $TOS_PATH"
# fi

echo "[$DATE] 备份完成"
