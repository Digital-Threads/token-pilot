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
