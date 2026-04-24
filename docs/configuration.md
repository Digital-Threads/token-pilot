# Configuration & Tool Profiles

## .token-pilot.json

Drop `.token-pilot.json` in your project root. All fields are optional.

```json
{
  "hooks": { "mode": "deny-enhanced", "denyThreshold": 300 },
  "sessionStart": { "enabled": true, "showStats": false, "maxReminderTokens": 250 },
  "agents": { "scope": null, "reminder": true },
  "smartRead": { "smallFileThreshold": 200 },
  "cache": { "maxSizeMB": 100, "watchFiles": true },
  "policies": { "maxFullFileReads": 10, "largeReadThreshold": 2000 },
  "astIndex": { "binaryPath": null },
  "updates": { "checkOnStartup": true, "autoUpdate": false },
  "ignore": ["node_modules/**", "dist/**", ".git/**"]
}
```

| Option | Default | What it does |
|--------|---------|--------------|
| `hooks.mode` | `"deny-enhanced"` | Read hook mode: `off` / `advisory` / `deny-enhanced` |
| `hooks.denyThreshold` | `300` | Line count above which the hook intervenes on unbounded `Read` |
| `sessionStart.enabled` | `true` | Re-inject MCP-rules reminder at every new session / `/clear` / `/compact` |
| `agents.scope` | `null` | Persisted scope of last `install-agents` run; reused silently |
| `agents.reminder` | `true` | Show the "agents not installed" startup nudge |
| `smartRead.smallFileThreshold` | `200` | Files with fewer lines bypass AST overhead and are returned in full |
| `cache.maxSizeMB` | `100` | File cache ceiling (LRU eviction) |
| `policies.maxFullFileReads` | `10` | Warn after N full-file reads in session |
| `policies.largeReadThreshold` | `2000` | Token threshold above which a read is flagged as "large" in analytics |

## Tool Profiles

Trim the advertised `tools/list` to save ~2 k tokens per session. Set via `TOKEN_PILOT_PROFILE` in your MCP server env block.

| Profile | Tools | ~Tokens | Use when |
|---------|------:|--------:|----------|
| `full` *(default)* | 22 | ~4 150 | All capabilities |
| `edit` | 16 | ~3 120 | Code-change workflows (nav + batch reads + `read_for_edit`) |
| `nav` | 10 | ~1 910 | Read-only exploration / subagents that only navigate |

Handlers remain active regardless of profile — a subagent that explicitly names a filtered-out tool still gets served. The profile only controls what appears in `tools/list` at session start.

### Setting a profile

**In `.mcp.json`:**
```json
{
  "mcpServers": {
    "token-pilot": {
      "command": "npx",
      "args": ["-y", "token-pilot"],
      "env": { "TOKEN_PILOT_PROFILE": "nav" }
    }
  }
}
```

**Via shell:**
```bash
TOKEN_PILOT_PROFILE=edit npx token-pilot
```

## Startup reminders

Token Pilot prints at most one short tip to **stderr** per MCP process when it detects a gap worth your attention. Reminders are single-fire per session and each is silenced by a dedicated env var:

| Reminder | Condition | Silence with |
|---------|-----------|--------------|
| `tp-*` subagents not installed | `npx token-pilot install-agents` was never run | `TOKEN_PILOT_NO_AGENT_REMINDER=1` |
| caveman not installed | caveman skill missing from `~/.claude/plugins/cache/` and `~/.gemini/extensions/` | `TOKEN_PILOT_NO_ECOSYSTEM_TIPS=1` |

Both reminders stay silent inside spawned subagents (`TOKEN_PILOT_SUBAGENT=1`) — noise never leaks into Task-dispatched helpers.

Run `npx token-pilot doctor` any time to see the full ecosystem coverage table. The reminder is only a nudge; the doctor output is the canonical view.

## Statusline badge

Claude Code supports a custom `statusLine` command that renders on every keystroke in the bottom bar. Token Pilot ships two scripts for this:

| Script | What it shows |
|--------|---------------|
| `hooks/tp-statusline.sh` | `[TP]` · `[TP:strict]` · `[TP deny 12k]` (with cumulative saved tokens for the current session) |
| `hooks/statusline-chain.sh` | Same, **plus** caveman's badge side-by-side if installed: `[CAVEMAN] [TP deny 12k]` |

Both scripts are hardened (bounded stdin read, whitelist sanitisation, no symlinks). Safe to keep enabled long-term.

### Install (manual, one-time)

Add to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash \"$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/statusline-chain.sh 2>/dev/null | head -1)\""
}
```

Restart Claude Code. `[TP]` appears in the status bar immediately. When caveman is also installed you'll see both badges.

### Other machines

Same two-line recipe, or run the Python one-liner below if you're wary of editing JSON by hand:

```bash
python3 -c "import json,os; p=os.path.expanduser('~/.claude/settings.json'); d=json.load(open(p)); d['statusLine']={'type':'command','command':'bash \"\$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/statusline-chain.sh 2>/dev/null | head -1)\"'}; json.dump(d,open(p,'w'),indent=2)"
```

### Troubleshooting

- `npx token-pilot doctor` surfaces a dedicated **statusline badge** block when the config is missing or when it points at `tp-statusline.sh` directly (we nudge you to the chain wrapper once caveman is detected).
- If you have a custom `statusLine` already, token-pilot respects it — no override.
- Colours: `[TP]` is blue (`38;5;39`), caveman's `[CAVEMAN]` is orange (`38;5;172`) — deliberately distinct.

## CLI Reference

```bash
token-pilot                              # start MCP server
token-pilot init                         # create/merge .mcp.json; prompt about subagents
token-pilot install-agents [--scope=user|project] [--force]
token-pilot uninstall-agents --scope=user|project
token-pilot bless-agents                 # extend third-party agents with token-pilot MCP
token-pilot unbless-agents <name>... | --all
token-pilot install-hook                 # install PreToolUse hooks
token-pilot uninstall-hook
token-pilot stats                        # totals + top files from hook-events.jsonl
token-pilot stats --session[=<id>] | --by-agent
token-pilot tool-audit                   # per-tool savings distribution
token-pilot tool-audit --json
token-pilot doctor                       # diagnostics (ast-index, config, upstream drift)
token-pilot doctor --check=env           # env var check only
token-pilot install-ast-index            # download ast-index binary (auto on first run)
```

## Architecture

```
src/
  index.ts              — CLI entry + MCP server bootstrap
  server.ts             — MCP server: 22 tool definitions + enforcement mode
  server/
    enforcement-mode.ts — TOKEN_PILOT_MODE parsing (advisory / deny / strict)
  ast-index/            — ast-index binary client + auto-install
  core/
    event-log.ts        — hook-events.jsonl + rotation + retention
    session-analytics.ts, policy-engine.ts, intent-classifier.ts
  hooks/
    installer.ts        — hook install/uninstall for Claude Code
    pre-bash.ts         — PreToolUse:Bash advisor (Bash/sh/eval/loop patterns)
    pre-grep.ts         — PreToolUse:Grep advisor (symbol-like pattern detection)
    session-start.ts    — SessionStart reminder handler
    summary-pipeline.ts — ast-index → regex → head+tail → pass-through
  cli/
    install-agents.ts, uninstall-agents.ts
    bless-agents.ts, unbless-agents.ts, doctor-drift.ts
    stats.ts, tool-audit.ts
  templates/agent-builder.ts
  config/loader.ts, defaults.ts
  handlers/             — 22 MCP tool handlers
  git/                  — HEAD + file watchers (cache invalidation)

scripts/
  build-agents.mjs      — render templates/ → dist/agents/
  bench-hook.mjs        — hook latency benchmark

templates/agents/       — source for tp-* family + shared preamble + contract
```
