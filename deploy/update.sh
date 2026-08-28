#!/usr/bin/env bash
# GitHub-first 发布检查脚本。
# 服务器运行目录不作为 Git 工作树，也不接受无目标的 git pull。
# 完整发布由部署机按 GitHub commit 生成发布包后执行。

set -euo pipefail

TARGET_COMMIT="${1:-}"
APP_DIR="${APP_DIR:-/var/www/silver-community-h5}"

if [[ -z "$TARGET_COMMIT" || ! "$TARGET_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "用法：$0 <GitHub commit SHA>" >&2
  exit 2
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "应用目录不存在：$APP_DIR" >&2
  exit 1
fi

if [[ -e "$APP_DIR/.git" ]]; then
  echo "拒绝：生产目录不应作为 Git 工作树，请使用 GitHub commit 发布包。" >&2
  exit 1
fi

echo "已校验目标 GitHub commit：$TARGET_COMMIT"
echo "当前脚本只负责阻止服务器侧漂移；发布请按 DEPLOYMENT.md 执行。"
