# `.token-pilot/` directory layout

Token Pilot writes state and telemetry to a `.token-pilot/` directory in your project root. Nothing is created eagerly — each sub-path appears only when a feature that needs it fires for the first time. Committing the directory is optional; most users add it to `.gitignore`.

## Files & directories

| Path | Who writes | When it appears | Purpose | Commit? |
|---|---|---|---|---|
| `hook-events.jsonl` | Read hook | First `Read` of a code file ≥ the `denyThreshold` | JSONL telemetry — one entry per hook decision (denied / allowed / bypass). Read by `session_analytics` and the adaptive-threshold logic. Auto-rotates at 10 MB, keeps 30-day history with 100 MB total cap. | **No** |
| `hook-denied.jsonl` | Read hook (legacy) | Historical, from before v0.20 | Older-format event log kept for backward compatibility with pre-v0.20 `loadDeniedReads()` readers. Safe to delete. | No |
| `snapshots/` | `session_snapshot` MCP tool | First call to `session_snapshot` | Archived + `latest.md` copy of each snapshot. Retention: last 10 archives. Surfaced by the SessionStart hook when `latest.md` is < 2h old. | Optional — commit `latest.md` if you want a next-session pointer to persist across clones |
| `context-registries/<session-id>.json` | MCP server | First dedup-aware tool call (`smart_read`, `read_symbol`, `read_range`, `smart_read_many`) with a `session_id` arg | Per-session dedup state — what was loaded, content hashes, load times. LRU cap 8 sessions in memory; older ones live only on disk. | **No** — session-local |
| `docs/<name>.md` | `token-pilot save-doc` CLI | Explicit user invocation | User-saved research / notes (curl output, WebFetch, long paste) that should survive compaction. Read back cheaply with `smart_read` / `read_range`. | Optional — commit if the doc is team-wide knowledge |
| `over-budget.log` | PostToolUse:Task hook | First time a `tp-*` subagent exceeds its frontmatter budget by > 10 % | JSONL audit trail for budget overages. Used by future `session_analytics` views. Empty file means no overages so far — good. | **No** |
| `tp-refactor-planner-<timestamp>.md` | `tp-refactor-planner` agent | Only when the agent's plan exceeds its response budget | Full step list spilled from the agent's response when it would have exceeded ~500 tokens inline. Response in chat points at this file. | Usually **no** — review and delete after the refactor lands |

## Quick rules

- **Nothing appears until you use it.** If you only ever ran the Read hook, only `hook-events.jsonl` will exist.
- **Safe to delete the whole folder** — everything rebuilds from the next tool call. You'll lose: dedup memory, snapshot history, saved research. You'll keep: installed hooks, agents, configs (those live elsewhere).
- **Add to `.gitignore`** unless your team uses snapshots or saved-docs as shared context.

Recommended `.gitignore` stanza:

```gitignore
# Token Pilot — session-local telemetry & state
.token-pilot/hook-events*.jsonl
.token-pilot/hook-denied.jsonl
.token-pilot/context-registries/
.token-pilot/over-budget.log
.token-pilot/tp-refactor-planner-*.md

# Keep these if you want shared snapshots / notes:
# !.token-pilot/snapshots/latest.md
# !.token-pilot/docs/
```

## Inspecting live state

Useful one-liners to audit a session in progress:

```bash
# How many hook events this session
wc -l .token-pilot/hook-events.jsonl

# Token savings so far (sum of savedTokens)
cat .token-pilot/hook-events.jsonl | python3 -c "
import sys, json
print(sum(json.loads(l).get('savedTokens', 0) for l in sys.stdin if l.strip()))"

# Any subagent blew its budget?
cat .token-pilot/over-budget.log 2>/dev/null || echo "no overages"

# Latest session snapshot (if any)
cat .token-pilot/snapshots/latest.md 2>/dev/null | head -20

# What dedup state is persisted
ls .token-pilot/context-registries/ 2>/dev/null
```

Or ask the agent — `mcp__token-pilot__session_analytics` returns the same signals in a structured form.
