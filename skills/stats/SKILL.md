---
name: stats
description: Show Token Pilot session analytics — token savings, per-tool breakdown, top files, per-agent grouping
command: stats
user_invocable: true
---

Two entry points:

1. **In-session rich summary (MCP tool).** Call the `session_analytics` MCP tool from the token-pilot server to display the current session's token savings with per-tool breakdown. Show the output to the user as-is.

2. **CLI shortcut (works without a running MCP server).** When the user explicitly asks for a specific view, or when the MCP tool is unavailable, invoke:

   - `token-pilot stats` — totals + top files by savedTokens
   - `token-pilot stats --session` — totals for the most recent session
   - `token-pilot stats --session=<id>` — totals for a specific session_id
   - `token-pilot stats --by-agent` — savings grouped by agent_type (tp-run, tp-onboard, …, or "main" for the top-level session)

The CLI reads `.token-pilot/hook-events.jsonl`, so it only shows data for qualifying Reads that were intercepted by the hook (not raw MCP tool calls — those live in session-analytics).
