#!/bin/bash
# token-pilot — statusline badge script for Claude Code.
#
# Reads the Claude Code statusline JSON payload from stdin, outputs a
# coloured badge with enforcement mode + cumulative saved tokens for the
# current session.
#
# Usage in ~/.claude/settings.json:
#   "statusLine": {
#     "type": "command",
#     "command": "bash /path/to/tp-statusline.sh"
#   }
#
# Pair with caveman via hooks/statusline-chain.sh — that wrapper renders
# both badges side-by-side.
#
# SECURITY — this script runs on every keystroke in the Claude Code UI.
# Rules lifted from caveman's hardening playbook:
#   - never `eval` or interpolate stdin into a shell context;
#   - sanitise every extracted field through a character whitelist;
#   - cap read sizes so a poisoned input can't blow memory;
#   - never fail open with raw bytes in the output — empty badge is fine.

set -u

MODE="${TOKEN_PILOT_MODE:-deny}"

# Sanitise mode → lowercase + whitelist. Unknown value falls back to default.
MODE=$(printf '%s' "$MODE" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z')
case "$MODE" in
advisory | deny | strict) ;;
*) MODE="deny" ;;
esac

# Read Claude Code stdin payload — bounded + optional.
INPUT=""
if [ ! -t 0 ]; then
	INPUT=$(head -c 16384 2>/dev/null || true)
fi

# Extract session_id and workspace.current_dir with plain sed. Each field
# is then sanitised through a character whitelist so nothing survives into
# a shell expansion that isn't safe.
SESSION_ID=""
CWD=""
if [ -n "$INPUT" ]; then
	SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -c 128)
	CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"current_dir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -c 4096)
fi

SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'a-zA-Z0-9-_')
# CWD: allow path chars only — no ; $ ` quotes, etc.
CWD=$(printf '%s' "$CWD" | tr -cd 'a-zA-Z0-9/._-')

# Compute cumulative savedTokens for this session, if we have enough info
# to find the events log. Any error → render without the saved-tokens suffix.
SAVED_SUFFIX=""
if [ -n "$SESSION_ID" ] && [ -n "$CWD" ] && [ -d "$CWD/.token-pilot" ]; then
	EVENTS_FILE="$CWD/.token-pilot/hook-events.jsonl"
	if [ -f "$EVENTS_FILE" ] && [ ! -L "$EVENTS_FILE" ]; then
		TOTAL=$(awk -v sid="$SESSION_ID" '
      {
        # Find session_id in the line
        if (match($0, /"session_id"[[:space:]]*:[[:space:]]*"[^"]+"/)) {
          line_sid = substr($0, RSTART, RLENGTH)
          sub(/^"session_id"[[:space:]]*:[[:space:]]*"/, "", line_sid)
          sub(/"$/, "", line_sid)
          if (line_sid == sid) {
            if (match($0, /"savedTokens"[[:space:]]*:[[:space:]]*-?[0-9]+/)) {
              t = substr($0, RSTART, RLENGTH)
              gsub(/[^0-9-]/, "", t)
              total += t + 0
            }
          }
        }
      }
      END { printf("%d", total + 0) }
    ' "$EVENTS_FILE" 2>/dev/null)

		if [ -n "${TOTAL:-}" ] && [ "${TOTAL:-0}" -gt 0 ] 2>/dev/null; then
			if [ "$TOTAL" -ge 1000000 ]; then
				SAVED_SUFFIX=$(printf " %dM" $((TOTAL / 1000000)))
			elif [ "$TOTAL" -ge 1000 ]; then
				SAVED_SUFFIX=$(printf " %dk" $((TOTAL / 1000)))
			else
				SAVED_SUFFIX=$(printf " %d" "$TOTAL")
			fi
		fi
	fi
fi

# Build the badge. Blue — distinct from caveman's orange so the pair
# `[CAVEMAN] [TP deny 12k]` is instantly scannable.
BLUE=$'\033[38;5;39m'
RESET=$'\033[0m'

if [ "$MODE" = "deny" ]; then
	# Default mode → skip the label, keep the badge short
	printf '%s[TP%s]%s' "$BLUE" "$SAVED_SUFFIX" "$RESET"
else
	printf '%s[TP:%s%s]%s' "$BLUE" "$MODE" "$SAVED_SUFFIX" "$RESET"
fi
