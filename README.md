# Token Pilot

**Enforcement layer for token-efficient AI coding.** MCP server + PreToolUse hook + six subagents. Cuts token consumption in AI coding assistants by up to **80%** without changing the way you work.

Three moving parts make it effective on every agent — including those without MCP access:

1. **MCP tools** — structural reads (`smart_read`, `read_symbol`, `read_for_edit`, …). Ask for an outline, load one function by name, not the whole file.
2. **PreToolUse hook** — intercepts large raw `Read` calls and returns a structural summary **inside the denial reason**. Works for any agent, even ones that only have `Read`.
3. **`tp-*` subagents** — six MCP-first delegates (`tp-run`, `tp-onboard`, `tp-pr-reviewer`, `tp-impact-analyzer`, `tp-refactor-planner`, `tp-test-triage`) with tight response budgets.

## How It Works

```
Traditional:  Read("user-service.ts")  →  500 lines  →  ~3000 tokens
Token Pilot:  smart_read("user-service.ts")  →  15-line outline  →  ~200 tokens
              read_symbol("UserService.updateUser")  →  45 lines  →  ~350 tokens
              After edit: read_diff("user-service.ts")  →  ~20 tokens
```

Files under 200 lines are returned in full (zero overhead for small files).

### Benchmarks

Measured on public open-source repos. Files ≥50 lines only:

| Repo | Files | Raw Tokens | Outline Tokens | Savings |
|------|------:|----------:|--------------:|--------:|
| [token-pilot](https://github.com/Digital-Threads/token-pilot) (TS) | 55 | 102,086 | 8,992 | **91%** |
| [express](https://github.com/expressjs/express) (JS) | 6 | 14,421 | 193 | **99%** |
| [fastify](https://github.com/fastify/fastify) (JS) | 23 | 50,000 | 3,161 | **94%** |
| [flask](https://github.com/pallets/flask) (Python) | 20 | 78,236 | 7,418 | **91%** |
| **Total** | **104** | **244,743** | **19,764** | **92%** |

> Measures `smart_read` outline savings only. Real sessions additionally benefit from session cache, `read_symbol` targeted loading, and `read_for_edit` minimal edit context. Reproduce: `npx tsx scripts/benchmark.ts`.

## Quick Start

```bash
npx -y token-pilot init
```

This does three things in order:

1. Creates (or merges into) `.mcp.json` with `token-pilot` + [`context-mode`](https://github.com/mksglu/claude-context-mode).
2. If you're on a TTY, asks: *"Install 6 tp-\* subagents now?"* — say yes, pick user or project scope, done.
3. Prints the hook-install hint for Claude Code users.

Restart your AI assistant to activate. Works with **Claude Code, Cursor, Codex, Antigravity, Cline**, and any MCP-compatible client.

<details>
<summary>Manual install (other MCP clients, from source, scripted CI)</summary>

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] }
  }
}
```

Claude Code shortcuts:

```bash
claude mcp add token-pilot -- npx -y token-pilot
claude mcp add --scope user token-pilot -- npx -y token-pilot
```

From source:

```bash
git clone https://github.com/Digital-Threads/token-pilot.git
cd token-pilot && npm install && npm run build
# then point .mcp.json at dist/index.js
```

Non-interactive subagent install (CI):

```bash
npx token-pilot install-agents --scope=user|project [--force]
```
</details>

## Modes

The PreToolUse hook has three modes. Set in `.token-pilot.json`:

| Mode | Behaviour |
|------|-----------|
| `off` | Hook is inert. |
| `advisory` | Denies unbounded Read with a short tip pointing at `smart_read` / `read_for_edit`. |
| `deny-enhanced` *(default)* | Denies the Read and returns a full structural summary (imports, exports, declarations) **inside** the denial reason. Works for subagents that lack MCP access. |

```json
{ "hooks": { "mode": "deny-enhanced", "denyThreshold": 300 } }
```

Env var overrides: `TOKEN_PILOT_MODE=off`, `TOKEN_PILOT_DENY_THRESHOLD=500`, `TOKEN_PILOT_BYPASS=1`.

## Subagents

Six Claude Code subagents guarantee MCP-first behaviour with tight response budgets and verdict-first output:

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-run` | General MCP-first workhorse; use proactively when no specialised agent fits | 800 |
| `tp-onboard` | Orient to an unfamiliar repo (layout, entry points, modules) | 600 |
| `tp-pr-reviewer` | Review a diff / PR / changeset; verdict-first, Critical/Important tiers | 600 |
| `tp-impact-analyzer` | Trace blast-radius of a change (callers, transitive deps) | 400 |
| `tp-refactor-planner` | Plan a refactor with exact edit context per step | 500 |
| `tp-test-triage` | Investigate test failures → root cause → minimal fix | 500 |

Install: `npx token-pilot install-agents`. Remove: `npx token-pilot uninstall-agents --scope=user|project`.

For third-party agents (e.g. `acc-*` plugins) that lack MCP access, `npx token-pilot bless-agents` creates project-level overrides that extend their tool allowlist. `doctor` flags any drifted upstreams; `unbless-agents` reverses.

## MCP Tools (21)

### Reading

| Tool | Instead of | Purpose |
|------|-----------|---------|
| `smart_read` | `Read` | AST outline; 90% fewer tokens on large files |
| `read_symbol` | `Read`+scroll | One class/function by name (`Class.method` supported) |
| `read_symbols` | N × `read_symbol` | Batch up to 10 symbols from one file |
| `read_for_edit` | `Read` before `Edit` | Minimal raw code around a symbol — copy directly as `old_string` |
| `read_range` | `Read` offset | Specific line range |
| `read_diff` | re-`Read` | Changed hunks since last `smart_read` |
| `smart_read_many` | multiple `Read` | Batch smart_read for up to 20 files |

### Search & Navigation

| Tool | Instead of | Purpose |
|------|-----------|---------|
| `find_usages` | `Grep` (refs) | All usages of a symbol; filters by scope/kind/lang |
| `project_overview` | `ls` + explore | Project type, frameworks, architecture, directory map |
| `related_files` | manual | Import graph: imports, importers, test files |
| `outline` | multiple `smart_read` | Compact overview of all code in a directory |
| `find_unused` | manual | Dead code detection |
| `code_audit` | multiple `Grep` | TODOs, deprecated symbols, structural patterns |
| `module_info` | manual | Deps, dependents, public API, unused deps |
| `smart_diff` | raw `git diff` | Structural diff with symbol mapping |
| `explore_area` | 3-5 calls | Structure + imports + tests + recent changes |
| `smart_log` | raw `git log` | Structured commits with category detection |
| `test_summary` | raw test output | Run tests → pass/fail summary + failure details |

### Session

| Tool | Purpose |
|------|---------|
| `session_snapshot` | Compact markdown snapshot (<200 tokens) of goal, decisions, facts, blockers, next step |
| `session_analytics` | Token savings: per-tool breakdown, top files, policy advisories |

## CLI

```bash
token-pilot                        # Start MCP server
token-pilot init                   # Create/merge .mcp.json; offers to install subagents
token-pilot install-agents [--scope=user|project] [--force]
token-pilot uninstall-agents --scope=user|project
token-pilot bless-agents           # Extend third-party agents with token-pilot MCP
token-pilot unbless-agents <name>... | --all
token-pilot install-hook           # Install PreToolUse hook
token-pilot uninstall-hook
token-pilot stats                  # Totals + top files from hook-events.jsonl
token-pilot stats --session[=<id>] | --by-agent
token-pilot doctor                 # Diagnostics (ast-index, config, upstream drift)
token-pilot install-ast-index      # Download ast-index binary (auto on first run)
```

### Environment variables

| Var | Effect |
|-----|--------|
| `TOKEN_PILOT_MODE=off` | Disable the hook for this process |
| `TOKEN_PILOT_BYPASS=1` | Pass every Read through |
| `TOKEN_PILOT_DENY_THRESHOLD=<n>` | Override `hooks.denyThreshold` |
| `TOKEN_PILOT_DEBUG=1` | Verbose hook logging to stderr |
| `TOKEN_PILOT_NO_AGENT_REMINDER=1` | Suppress the "tp-* not installed" stderr nudge |
| `TOKEN_PILOT_SUBAGENT=1` | Mark the MCP server as running inside a subagent |

## Configuration

Drop `.token-pilot.json` in your project root. All fields optional.

```json
{
  "hooks": { "mode": "deny-enhanced", "denyThreshold": 300 },
  "sessionStart": { "enabled": true, "showStats": false, "maxReminderTokens": 250 },
  "agents": { "scope": null, "reminder": true },
  "smartRead": { "smallFileThreshold": 200 },
  "cache": { "maxSizeMB": 100, "watchFiles": true },
  "policies": { "maxFullFileReads": 10, "largeReadThreshold": 2000 },
  "ignore": ["node_modules/**", "dist/**", ".git/**"]
}
```

| Option | Default | What it does |
|--------|---------|--------------|
| `hooks.mode` | `"deny-enhanced"` | `off` / `advisory` / `deny-enhanced` |
| `hooks.denyThreshold` | `300` | Line count above which the hook starts denying unbounded Read |
| `sessionStart.enabled` | `true` | Re-inject MCP-rules reminder at every new session / `/clear` / `/compact` |
| `agents.scope` | `null` | Persisted scope of last `install-agents` run; reused silently |
| `agents.reminder` | `true` | Show the "agents not installed" startup nudge |
| `smartRead.smallFileThreshold` | `200` | Files with fewer lines bypass AST overhead |
| `cache.maxSizeMB` | `100` | File cache ceiling (LRU eviction) |
| `policies.maxFullFileReads` | `10` | Warn after N full-file reads in session |

## Integration with context-mode

Token Pilot is complementary to [claude-context-mode](https://github.com/mksglu/claude-context-mode):

- **Token Pilot** — code files (AST structure, symbols, imports)
- **context-mode** — non-code data (shell output, logs, JSON dumps) via sandbox + BM25

`init` sets up both; they don't overlap. If context-mode is unavailable, Token Pilot works standalone.

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, C/C++, PHP, Ruby. Non-code (JSON/YAML/Markdown/TOML) gets structural summaries. Regex fallback handles most other languages.

## Troubleshooting

```bash
# Verify installation
npx token-pilot doctor

# Common issues:
# - "ast-index not found" → npx token-pilot install-ast-index
# - "hooks not firing" → restart your AI assistant
# - "stats shows No events" → hook events accumulate in .token-pilot/hook-events.jsonl after the first denied Read

# Update everything
npm i -g token-pilot@latest
```

## Architecture

```
src/
  index.ts              — CLI entry + MCP server bootstrap
  server.ts             — MCP server setup, 21 tool definitions
  ast-index/            — ast-index binary client + auto-install
  core/
    event-log.ts        — hook-events.jsonl + rotation + retention
    session-analytics.ts, policy-engine.ts, intent-classifier.ts
  hooks/
    installer.ts        — Hook install/uninstall for Claude Code
    session-start.ts    — SessionStart reminder handler
    summary-pipeline.ts — ast-index → regex → head+tail → pass-through
  cli/
    install-agents.ts, uninstall-agents.ts
    bless-agents.ts, unbless-agents.ts, doctor-drift.ts
    stats.ts
  templates/agent-builder.ts
  config/loader.ts, defaults.ts
  handlers/             — 21 MCP tool handlers
  git/                  — HEAD + file watchers (cache invalidation)

scripts/
  build-agents.mjs      — Render templates/ → dist/agents/
  bench-hook.mjs        — Hook latency benchmark

templates/agents/       — Source for tp-* family + shared preamble + contract
```

## Credits

Built on top of:

- [ast-index](https://github.com/defendend/ast-index) — Tree-sitter AST indexer in Rust (auto-installed)
- [@ast-grep/cli](https://ast-grep.github.io/) — Structural code pattern search
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) — Model Context Protocol
- [chokidar](https://github.com/paulmillr/chokidar) — File watching

## License

MIT
