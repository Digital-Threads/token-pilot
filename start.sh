#!/usr/bin/env bash
# Token Pilot bootstrap script for Claude Code plugin system.
# Handles auto-install of dependencies and build on first run.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Install runtime dependencies when the package is incomplete.
if [ ! -f "node_modules/@modelcontextprotocol/sdk/package.json" ]; then
  echo "[token-pilot] Installing runtime dependencies..." >&2
  npm install --production --no-audit --no-fund 2>&1 >&2
fi

# 2. Build if dist/ is missing.
if [ ! -f "dist/index.js" ]; then
  echo "[token-pilot] Building..." >&2
  if [ ! -f "node_modules/typescript/bin/tsc" ]; then
    npm install --no-audit --no-fund 2>&1 >&2
  fi
  npm run build 2>&1 >&2
fi

# 3. Start the MCP server.
# Pass CLAUDE_PROJECT_DIR as project root if available, otherwise cwd.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
exec node "$SCRIPT_DIR/dist/index.js" "$PROJECT_ROOT"
