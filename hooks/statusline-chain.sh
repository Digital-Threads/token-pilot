#!/bin/bash
# token-pilot — statusline chain.
#
# Claude Code allows a single statusLine command. This wrapper runs
# multiple badge scripts and joins their output with spaces, so a user
# who has both token-pilot and caveman (or similar MIT ecosystem tools)
# sees `[CAVEMAN] [TP deny 12k]` in one line instead of having to pick.
#
# Detection is lazy — each badge script auto-discovers in a known plugin
# cache path; if the tool isn't installed its call returns nothing and
# we skip it cleanly.
#
# Usage in ~/.claude/settings.json:
#   "statusLine": {
#     "type": "command",
#     "command": "bash /path/to/statusline-chain.sh"
#   }

set -u

# Cache stdin once — Claude Code sends a single JSON blob, and we need to
# feed the same blob into every child badge script.
INPUT=""
if [ ! -t 0 ]; then
	INPUT=$(head -c 16384 2>/dev/null || true)
fi

run_badge() {
	local script="$1"
	if [ -n "$script" ] && [ -f "$script" ] && [ ! -L "$script" ]; then
		printf '%s' "$INPUT" | bash "$script" 2>/dev/null
	fi
}

# Resolve each candidate script. Use latest cache dir by mtime.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TP_BADGE=$(run_badge "$SCRIPT_DIR/tp-statusline.sh")

CAVEMAN_SCRIPT=$(ls -t "$HOME"/.claude/plugins/cache/caveman/caveman/*/hooks/caveman-statusline.sh 2>/dev/null | head -1)
CAVEMAN_BADGE=$(run_badge "$CAVEMAN_SCRIPT")

# Join with a single space. Any empty parts drop out cleanly.
OUT=""
for part in "$CAVEMAN_BADGE" "$TP_BADGE"; do
	if [ -n "$part" ]; then
		if [ -n "$OUT" ]; then
			OUT="$OUT $part"
		else
			OUT="$part"
		fi
	fi
done

printf '%s' "$OUT"
