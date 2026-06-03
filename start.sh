#!/usr/bin/env bash
set -euo pipefail

RUNTIME_NODE="/Users/guojing/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -x "$RUNTIME_NODE" ]; then
  "$RUNTIME_NODE" "$PROJECT_DIR/server.js"
else
  node "$PROJECT_DIR/server.js"
fi
