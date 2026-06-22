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

# Render an integer token count as a short, one-decimal string
# (12345 → "12.3k", 1500000 → "1.5M", 500 → "500").
fmt_tokens() {
	n="$1"
	if [ "$n" -ge 1000000 ]; then
		printf '%d.%dM' $((n / 1000000)) $(((n % 1000000) / 100000))
	elif [ "$n" -ge 1000 ]; then
		printf '%d.%dk' $((n / 1000)) $(((n % 1000) / 100))
	else
		printf '%d' "$n"
	fi
}

# Sum token savings from one JSONL log. Echoes an integer.
#   $1 = file
#   $2 = mode: "saved" (hook-events.jsonl uses a savedTokens field) or
#        "delta" (tool-calls.jsonl savings = tokensWouldBe − tokensReturned)
#   $3 = session_id filter — "" sums the whole project, otherwise only
#        rows tagged with that session_id (already whitelisted, so it is
#        injection-safe as an awk variable).
sum_log() {
	{ [ -f "$1" ] && [ ! -L "$1" ]; } || {
		printf '0'
		return
	}
	awk -v mode="$2" -v sid="$3" '
    sid != "" && index($0, "\"session_id\":\"" sid "\"") == 0 { next }
    {
      if (mode == "saved") {
        if (match($0, /"savedTokens"[[:space:]]*:[[:space:]]*-?[0-9]+/)) {
          t = substr($0, RSTART, RLENGTH); gsub(/[^0-9-]/, "", t); total += t + 0
        }
      } else if (mode == "wouldbe") {
        # Raw-equivalent tokens the structural reads stood in for (the baseline
        # the savings % is measured against): sum of tokensWouldBe.
        if (match($0, /"tokensWouldBe"[[:space:]]*:[[:space:]]*-?[0-9]+/)) {
          t = substr($0, RSTART, RLENGTH); gsub(/[^0-9-]/, "", t); total += t + 0
        }
      } else {
        rw = 0; rt = 0
        if (match($0, /"tokensWouldBe"[[:space:]]*:[[:space:]]*-?[0-9]+/)) {
          s = substr($0, RSTART, RLENGTH); gsub(/[^0-9-]/, "", s); rw = s + 0
        }
        if (match($0, /"tokensReturned"[[:space:]]*:[[:space:]]*-?[0-9]+/)) {
          s = substr($0, RSTART, RLENGTH); gsub(/[^0-9-]/, "", s); rt = s + 0
        }
        d = rw - rt; if (d > 0) total += d
      }
    }
    END { printf("%d", total + 0) }
  ' "$1" 2>/dev/null
}

# Read Claude Code stdin payload — bounded + optional.
INPUT=""
if [ ! -t 0 ]; then
	INPUT=$(head -c 16384 2>/dev/null || true)
fi

# Extract session_id and the working directory with plain sed. Each
# field is sanitised through a character whitelist so nothing survives
# into an unsafe shell expansion.
#
# v0.42.1 — read BOTH `current_dir` and `cwd`. Claude Code's statusline
# payload has varied between `workspace.current_dir` and a top-level
# `cwd` across versions; reading whichever is present keeps the badge
# from going blank when the field name differs (the bare-[TP] symptom
# was partly this — the project dir wasn't resolved, so no events file
# was found).
SESSION_ID=""
CWD=""
if [ -n "$INPUT" ]; then
	SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -c 128)
	CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"current_dir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -c 4096)
	if [ -z "$CWD" ]; then
		CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -c 4096)
	fi
fi

SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'a-zA-Z0-9-_')
# CWD: allow path chars only — no ; $ ` quotes, etc.
CWD=$(printf '%s' "$CWD" | tr -cd 'a-zA-Z0-9/._-')

# Resolve the project root by walking UP from CWD to the nearest ancestor
# that has a `.token-pilot/` dir — same way git locates `.git`.
#
# v0.42.4 — the old code checked only the exact CWD. In a monorepo (or a
# git worktree, or any session `cd`'d into a subdir) the events log lives
# at the repo root while CWD is e.g. `<root>/apps/api`, so the check
# failed and the badge rendered a bare `[TP]` with no token count. Walking
# up fixes the dominant "bare [TP]" symptom. The walk is bounded to 40
# levels so a malformed CWD can never loop forever.
PROJECT_ROOT=""
if [ -n "$CWD" ]; then
	dir="$CWD"
	depth=0
	while [ -n "$dir" ] && [ "$depth" -lt 40 ]; do
		if [ -d "$dir/.token-pilot" ]; then
			PROJECT_ROOT="$dir"
			break
		fi
		parent=$(dirname "$dir")
		[ "$parent" = "$dir" ] && break
		dir="$parent"
		depth=$((depth + 1))
	done
fi

# Compute savedTokens two ways from the events log: the current SESSION
# (live — grows as this session reads code) and the cumulative PROJECT
# total (every session). Any error → render without the suffix.
#
# v0.43.0 — show both: `s:<session> · <project>`. The session number is
# what the user watches climb during a run; the project total is the
# all-time figure. When the session has saved nothing yet (fresh start),
# fall back to the project total alone so the badge is never empty after
# first use — that was the v0.42.1 lesson, kept here as the fallback
# rather than the only mode.
SAVED_SUFFIX=""
if [ -n "$PROJECT_ROOT" ]; then
	TP_DIR="$PROJECT_ROOT/.token-pilot"
	EVENTS_FILE="$TP_DIR/hook-events.jsonl"
	TOOLS_FILE="$TP_DIR/tool-calls.jsonl"

	# Two savings sources, summed:
	#   • hook denials — hook-events.jsonl, `savedTokens` (raw Read/Grep
	#     intercepted and redirected to a structural tool);
	#   • MCP-tool structural reads — tool-calls.jsonl,
	#     tokensWouldBe − tokensReturned (smart_read / outline / find_usages …).
	# v0.43.0 — tool-calls rows now carry the real session_id (the MCP
	# server reads CLAUDE_CODE_SESSION_ID), so both sources can be split
	# per session. Before this the MCP savings — usually the larger share —
	# were invisible to the badge.
	PROJECT_TOTAL=$(($(sum_log "$EVENTS_FILE" saved "") + $(sum_log "$TOOLS_FILE" delta "")))
	SESSION_TOTAL=0
	if [ -n "$SESSION_ID" ]; then
		SESSION_TOTAL=$(($(sum_log "$EVENTS_FILE" saved "$SESSION_ID") + $(sum_log "$TOOLS_FILE" delta "$SESSION_ID")))
	fi

	# Efficiency of the structural reads: saved ÷ would-be-raw (tool-calls — the
	# source with a real baseline). Shown as a % so the savings number reads as a
	# RATIO of what those reads WOULD have cost, not a fraction of the whole context.
	WOULDBE=$(sum_log "$TOOLS_FILE" wouldbe "")
	TOOLS_SAVED=$(sum_log "$TOOLS_FILE" delta "")
	EFF=""
	if [ "$WOULDBE" -gt 0 ] 2>/dev/null; then
		EFF=" $((TOOLS_SAVED * 100 / WOULDBE))%"
	fi

	# Label the cumulative number "saved" + append the efficiency %, so it can't be
	# misread as "saved / total-context". `s:` is the live per-session figure.
	if [ "$SESSION_TOTAL" -gt 0 ] 2>/dev/null && [ "$PROJECT_TOTAL" -gt 0 ] 2>/dev/null; then
		SAVED_SUFFIX=" s:$(fmt_tokens "$SESSION_TOTAL") · saved $(fmt_tokens "$PROJECT_TOTAL")$EFF"
	elif [ "$PROJECT_TOTAL" -gt 0 ] 2>/dev/null; then
		# Fresh session, nothing saved yet — show the project total alone.
		SAVED_SUFFIX=" saved $(fmt_tokens "$PROJECT_TOTAL")$EFF"
	elif [ "$SESSION_TOTAL" -gt 0 ] 2>/dev/null; then
		SAVED_SUFFIX=" s:$(fmt_tokens "$SESSION_TOTAL") saved"
	fi
fi

# v0.43.0 — Claude.ai subscription rate limits, when present.
#
# CC 2.1.80+ statusline payload carries (verified against the 2.1.167
# bundle):
#   "rate_limits": {
#     "five_hour": { "used_percentage": N, "resets_at": N },
#     "seven_day": { "used_percentage": N, "resets_at": N }
#   }
# Both blocks are optional — only present for Claude.ai subscribers after
# the first API response. Unlike the cumulative token total, these numbers
# move every turn, so the badge finally reflects something live. Parsed
# with sed (no jq dependency) and whitelisted to digits — same security
# posture as the rest of the script.
RL_SUFFIX=""
if [ -n "$INPUT" ]; then
	FIVE=$(printf '%s' "$INPUT" | sed -n 's/.*"five_hour"[^}]*"used_percentage"[[:space:]]*:[[:space:]]*\([0-9]\{1,3\}\).*/\1/p' | head -c 3)
	SEVEN=$(printf '%s' "$INPUT" | sed -n 's/.*"seven_day"[^}]*"used_percentage"[[:space:]]*:[[:space:]]*\([0-9]\{1,3\}\).*/\1/p' | head -c 3)
	FIVE=$(printf '%s' "$FIVE" | tr -cd '0-9')
	SEVEN=$(printf '%s' "$SEVEN" | tr -cd '0-9')
	[ -n "$FIVE" ] && RL_SUFFIX=" 5h:${FIVE}%"
	[ -n "$SEVEN" ] && RL_SUFFIX="${RL_SUFFIX} 7d:${SEVEN}%"
fi

# Build the badge. Blue — distinct from caveman's orange so the pair
# `[CAVEMAN] [TP deny 12k]` is instantly scannable.
BLUE=$'\033[38;5;39m'
RESET=$'\033[0m'

if [ "$MODE" = "deny" ]; then
	# Default mode → skip the label, keep the badge short
	printf '%s[TP%s%s]%s' "$BLUE" "$SAVED_SUFFIX" "$RL_SUFFIX" "$RESET"
else
	printf '%s[TP:%s%s%s]%s' "$BLUE" "$MODE" "$SAVED_SUFFIX" "$RL_SUFFIX" "$RESET"
fi
