#!/usr/bin/env bash
# Token Pilot bootstrap script for Claude Code plugin system.
# Handles auto-install of dependencies and build on first run.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Capture user's working directory BEFORE `cd $SCRIPT_DIR` — this is the
# project root fallback when CLAUDE_PROJECT_DIR is not set. Without this,
# `$(pwd)` below would resolve to the plugin cache dir and every relative
# file path would be resolved inside the plugin install, not the project.
USER_CWD="${PWD:-$(pwd)}"

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
# Priority for project root:
#   1. CLAUDE_PROJECT_DIR  — set by Claude Code for the active workspace
#   2. USER_CWD            — the user's shell working directory (captured pre-cd)
# Passing the plugin cache dir here would poison every relative path lookup.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$USER_CWD}"
exec node "$SCRIPT_DIR/dist/index.js" "$PROJECT_ROOT"
