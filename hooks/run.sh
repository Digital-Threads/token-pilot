#!/usr/bin/env bash
# Hook launcher for the Claude Code plugin install.
#
# `dist/` is a build artifact and is not in git, but the marketplace
# installs this plugin FROM git. start.sh builds it — except start.sh only
# runs when the MCP server starts, and hooks are invoked directly. So on a
# freshly installed or freshly updated plugin, every hook fired before the
# first MCP server start hit a missing dist/index.js and died. Silently:
# Claude Code treats a failed hook as "no decision", so enforcement simply
# stopped existing until something else happened to build.
#
# This wrapper makes the hook path self-sufficient. Three rules:
#
#   1. Build if dist is missing — ~3s, and node_modules ships with the
#      plugin so no install is needed.
#   2. Guard the build with a lock. A session start fires several hooks at
#      once; without this they would all run tsc into the same directory.
#   3. Never block the user's tool call. If the build fails or another
#      process is still building, exit 0 and let the call through. A hook
#      that cannot decide must not become a hook that refuses.
#
# No `cd`: the hooks read process.cwd() as the project root, so this has to
# exec from wherever Claude Code invoked it.

# A Claude Code mod (hooks/mod) that serves this action has already handled
# the call in-process; it lists the actions it serves in TOKEN_PILOT_MOD at
# session start. Exact, comma-delimited match: hook-pre must not silence
# hook-pre-bash. With the mod off the variable is unset and nothing changes.
#
# The variable reaches every process the session starts, so a nested
# `claude` (an older one, or one with mods off) inherits it. Step aside only
# for a session the mod has served: TOKEN_PILOT_MOD_SESSION lists their ids
# (after /clear an earlier session's background agent still runs), matched
# against the payload's session_id with shell builtins — no grep or sed on
# a path every tool call takes. Only the first member is looked at: Claude
# Code writes session_id first, and a session_id inside tool_input (our MCP
# tools take one) must not count. Anything else and the hook simply runs.
# No list, nothing to match: stdin is left alone and the hook runs as before.
HAVE_INPUT=
case ",${TOKEN_PILOT_MOD:-}," in
	*",$1,"*)
		if [ -n "${TOKEN_PILOT_MOD_SESSION:-}" ]; then
			INPUT=$(cat)
			HAVE_INPUT=1
			FIRST=${INPUT%%,*}
			IFS=,
			for S in $TOKEN_PILOT_MOD_SESSION; do
				[ -n "$S" ] || continue
				case $FIRST in
					*"\"session_id\":\"$S\"" | *"\"session_id\": \"$S\"") exit 0 ;;
				esac
			done
			unset IFS
		fi
		;;
esac

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$PLUGIN_DIR/dist/index.js"

if [ ! -f "$ENTRY" ]; then
	LOCK="$PLUGIN_DIR/.build.lock"
	if mkdir "$LOCK" 2>/dev/null; then
		echo "[token-pilot] building plugin (first run after install)…" >&2
		(cd "$PLUGIN_DIR" && npm run build >&2 2>&1) || true
		rmdir "$LOCK" 2>/dev/null || true
	else
		# Another hook won the race — wait for it rather than build twice.
		i=0
		while [ ! -f "$ENTRY" ] && [ "$i" -lt 30 ]; do
			sleep 1
			i=$((i + 1))
		done
	fi
fi

# Still nothing to run: stay out of the way instead of failing the call.
[ -f "$ENTRY" ] || exit 0

# The MCP-path hook has its own small entry (about 23 ms instead of 200).
TARGET="$ENTRY"
[ "$1" = hook-mcp-path ] && TARGET="$PLUGIN_DIR/dist/hooks/hook-mcp-path.js"

# stdin was read above to look for the session id: hand it on.
if [ -n "$HAVE_INPUT" ]; then
	exec node "$TARGET" "$@" <<EOF
$INPUT
EOF
fi

exec node "$TARGET" "$@"
