# Token Pilot

**Token-efficient AI coding, enforced.** Cuts context consumption in AI coding assistants by up to **90%** without changing the way you work.

Three layers, each useful on its own, stronger together:

1. **MCP tools** — structural reads (`smart_read`, `read_symbol`, `read_for_edit`, …). Ask for an outline or load one function by name instead of the whole file.
2. **Read hook** — intercepts large raw `Read` calls and answers with a structural summary in the denial reason itself. Works for every agent, including ones that only have basic tools.
3. **`tp-*` subagents** — Claude Code delegates with MCP-first behaviour and tight response budgets. Tier 1 workhorses (`tp-run`, `tp-onboard`, `tp-pr-reviewer`, `tp-impact-analyzer`, `tp-refactor-planner`, `tp-test-triage`) plus Tier 2 specialists (`tp-debugger`, `tp-migration-scout`, `tp-test-writer`, `tp-dead-code-finder`, `tp-commit-writer`).

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

This does two things:

1. Creates (or merges into) `.mcp.json` with `token-pilot` + [`context-mode`](https://github.com/mksglu/claude-context-mode).
2. If you're on a TTY, asks whether to install the `tp-*` subagents now — pick `user` (available in every project) or `project` scope.

Restart your AI assistant to activate. The Read hook auto-installs the first time `token-pilot` starts inside Claude Code. Works with **Claude Code, Cursor, Codex, Antigravity, Cline**, and any MCP-compatible client — though support varies (see matrix below).

## Client support matrix

Not every capability works in every client. Subagents are a Claude Code concept; other clients still get the MCP tools + Read hook but won't auto-invoke `tp-*` agents.

| Client          | MCP tools | Read hook (context-mode) | `tp-*` subagents (25) | `model:` frontmatter (haiku) | Budget watchdog |
|-----------------|:---------:|:------------------------:|:---------------------:|:----------------------------:|:---------------:|
| Claude Code     | ✅        | ✅                       | ✅                    | ✅                           | ✅              |
| Cursor          | ✅        | ✅                       | ❌                    | ❌ (ignored)                 | ❌              |
| Codex CLI       | ✅        | ✅                       | ❌                    | ❌                           | ❌              |
| Gemini CLI      | ✅        | ✅                       | ❌                    | ❌                           | ❌              |
| Cline (VS Code) | ✅        | ✅                       | ❌                    | ❌                           | ❌              |
| Antigravity     | ✅        | ✅                       | ❌                    | ❌                           | ❌              |

**What non-Claude users get (~60% of the package):**
- All 22 MCP tools: `smart_read`, `read_symbol`, `find_usages`, `smart_diff`, `code_audit`, `session_analytics`, etc.
- The Read hook that blocks oversized reads and suggests token-saving alternatives.

**What needs Claude Code to work:**
- 19 `tp-*` subagents invoked via the `Task` tool.
- `model: claude-haiku-4-5` frontmatter on format-bound agents (commit-writer, session-restorer, onboard) — cheaper runs.
- `PostToolUse:Task` budget watchdog — logs agent runs exceeding their declared budget to `.token-pilot/over-budget.log`.

`install-agents` detects non-Claude clients via env vars + filesystem markers (`CURSOR_TRACE_ID`, `~/.codex/`, `~/.gemini/`, etc.) and **skips installing** unless you pass `--scope=user|project` explicitly.

## Manual MCP install (per-client examples)

If `init` isn't right for your setup — CI, non-TTY environments, editing a shared team config, or a client without an interactive installer — add Token Pilot as an MCP server directly. The server command is `npx -y token-pilot` on every client; only the config file shape differs.

### Claude Code

Three paths — pick one, they're mutually exclusive.

**A. As a Claude Code plugin (one-step install — hooks + MCP registered together):**

```bash
claude plugin marketplace add https://github.com/Digital-Threads/token-pilot
claude plugin install token-pilot@token-pilot
```

Claude Code clones the repo into `~/.claude/plugins/cache/token-pilot/`, sets `CLAUDE_PLUGIN_ROOT`, and registers the MCP server + all hooks declared in `.claude-plugin/hooks/hooks.json`. No `install-hook` call needed. `install-agents` still applies for the tp-* subagents (they're separate from plugin hooks).

**B. Via MCP config (npm-based, no plugin system):**

```bash
claude mcp add token-pilot -- npx -y token-pilot
claude mcp add --scope user token-pilot -- npx -y token-pilot
claude mcp add --scope project token-pilot -- npx -y token-pilot

# Or edit .mcp.json directly (project-level) / ~/.mcp.json (user-level)
```

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] },
    "context-mode": { "command": "npx", "args": ["-y", "claude-context-mode"] }
  }
}
```

Then `npx token-pilot install-hook` to register the PreToolUse Read/Edit hooks and `npx token-pilot install-agents --scope=user` to install the 25 tp-* subagents.

**C. One-liner `init`:** `npx -y token-pilot init` — writes path B config for you, then prompts about subagents.

### Cursor

Cursor reads `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] }
  }
}
```

### Codex CLI

Codex reads `~/.codex/config.toml`:

```toml
[mcp_servers.token-pilot]
command = "npx"
args = ["-y", "token-pilot"]
```

### Cline (VS Code)

Cline reads `cline_mcp_settings.json` (accessible via Cline panel → MCP Servers → Edit):

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] }
  }
}
```

### Any MCP-compatible client

Use the generic MCP protocol — the server is a plain stdio process:

```
command: npx
args:    -y token-pilot
```

No env vars required. Optional overrides:

| Env var | Default | Purpose |
|---|---|---|
| `TOKEN_PILOT_PROFILE` | `full` | `nav`/`edit`/`full` — trims the advertised `tools/list` payload to save ~2 k tokens per session (see "Tool profiles" below) |
| `TOKEN_PILOT_DENY_THRESHOLD` | `300` | Line count above which the Read hook intervenes |
| `TOKEN_PILOT_ADAPTIVE_THRESHOLD` | `false` | Enable the adaptive curve as the session burns |
| `TOKEN_PILOT_BYPASS` | unset | Set to `1` to disable the Read hook for one session |
| `TOKEN_PILOT_SKIP_POSTINSTALL` | unset | Skip the `ast-index` safety-net install at `npm install` time |

### Tool profiles

| Profile | Tools | ~Tokens | Use when |
|---------|------:|--------:|----------|
| `full` *(default)* | 22 | ~4 150 | All capabilities |
| `edit` | 16 | ~3 120 | Code-change workflows (nav + batch reads + `read_for_edit`) |
| `nav` | 10 | ~1 910 | Read-only exploration / subagents that only navigate |

Set via `TOKEN_PILOT_PROFILE` in your MCP server env block. Handlers stay live regardless — a subagent that explicitly names a filtered-out tool still gets served. The profile only trims what we advertise in `tools/list` at session start.

### Subagents (Claude Code only)

`tp-*` subagents are a Claude Code feature. Other clients use only the MCP tools + Read hook. To install on a target scope explicitly:

```bash
npx token-pilot install-agents --scope=user            # all projects
npx token-pilot install-agents --scope=project         # this repo only
npx token-pilot install-agents --scope=user --force    # re-apply after an update
```

### From source (contributors / vendored installs)

```bash
git clone https://github.com/Digital-Threads/token-pilot.git
cd token-pilot && npm install && npm run build
# Point your client's config at dist/index.js:
#   "command": "node", "args": ["/abs/path/to/token-pilot/dist/index.js"]
```

## Modes

The Read hook has three modes. Set in `.token-pilot.json`:

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

Claude Code subagents guarantee MCP-first behaviour with tight response budgets and verdict-first output. **Tier 1** are everyday workhorses invoked proactively; **Tier 2** are focused specialists you reach for when a specific kind of work comes up (debugging, migration, test authoring, cleanup, commits).

**Tier 1 — workhorses:**

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-run` | General MCP-first workhorse; use proactively when no specialised agent fits | 800 |
| `tp-onboard` | Orient to an unfamiliar repo (layout, entry points, modules) | 600 |
| `tp-pr-reviewer` | Review a diff / PR / changeset; verdict-first, Critical/Important tiers | 600 |
| `tp-impact-analyzer` | Trace blast-radius of a change (callers, transitive deps) | 400 |
| `tp-refactor-planner` | Plan a refactor with exact edit context per step | 500 |
| `tp-test-triage` | Investigate test failures → root cause → minimal fix | 500 |

**Tier 2 — specialists:**

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-debugger` | Stack trace / error → root-cause line via call-tree traversal | 700 |
| `tp-migration-scout` | Pre-migration impact map grouped by effort class | 800 |
| `tp-test-writer` | Write tests for ONE symbol, mirrors project style, runs tests | 900 |
| `tp-dead-code-finder` | Cross-checked dead-code detection, output-only (never deletes) | 600 |
| `tp-commit-writer` | Draft Conventional-Commit from staged diff; refuses failing tests | 400 |
| `tp-history-explorer` | "Why is this like this?" — minimum commit chain explaining current state | 600 |
| `tp-audit-scanner` | Read-only security / quality audit; Critical / Important / Minor findings | 800 |
| `tp-session-restorer` | Rehydrate state after /clear or compaction from latest snapshot | 400 |

**Tier 3 — combo / workflow:**

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-review-impact` | Pre-merge blast-radius review (diff × dependents × API surface) | 700 |
| `tp-test-coverage-gapper` | Find symbols with zero test references, prioritised | 500 |
| `tp-api-surface-tracker` | Public API diff vs last release → MAJOR / MINOR / PATCH verdict | 600 |
| `tp-dep-health` | Dep audit: stale × heavily-used × removable | 600 |
| `tp-incident-timeline` | Correlate an incident window with commits, rank likely culprits | 700 |

**Tier 4 — methodology (v0.27.0, inspired by @addyosmani/agent-skills):**

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-context-engineer` | Audit / write CLAUDE.md / AGENTS.md rules files per project | 800 |
| `tp-spec-writer` | Pre-code spec with gated workflow; surfaces assumptions before code | 900 |
| `tp-performance-profiler` | Measure → identify → fix → verify → guard; refuses to optimize without data | 800 |
| `tp-incremental-builder` | Multi-file feature work in thin vertical slices, test between each | 900 |
| `tp-doc-writer` | ADRs + READMEs + API docs; documents *why* not *what* | 700 |
| `tp-ship-coordinator` | 5-pillar pre-launch checklist (quality / security / observability / rollback / rollout) | 800 |

### Model tiers

Every agent carries an explicit `model:` field in its frontmatter. Default dispatch:
- **haiku** (9 agents) — structured / format-bound output (commit messages, onboarding maps, ADRs, session briefings)
- **sonnet** (15 agents) — reasoning tasks (review, debug, test, plan, audit, spec, profile, ship)
- **inherit** (1 agent) — deep correlation needing whatever the main thread uses (`tp-incident-timeline`)

Effect: under Opus 4.7's +35% tokenizer tax, keeping the majority of agent spawns on haiku / sonnet saves 5-10× model cost vs an all-Opus baseline.

Every agent's budget is enforced post-response — overshoots beyond 10 % land in `.token-pilot/over-budget.log`.

`init` offers to install these; to do it later or add them to another project, run `npx token-pilot install-agents`. Remove with `npx token-pilot uninstall-agents --scope=user|project`.

For third-party agents (e.g. `acc-*` plugins) whose tool allowlist excludes token-pilot MCP, `npx token-pilot bless-agents` creates project-level overrides that add the missing tools. `doctor` warns when the original agent has changed since blessing; `unbless-agents` reverses.

## MCP Tools

### Reading

| Tool | Instead of | Purpose |
|------|-----------|---------|
| `smart_read` | `Read` | AST outline; 90% fewer tokens on large files |
| `read_symbol` | `Read`+scroll | One class/function by name (`Class.method` supported) |
| `read_symbols` | N × `read_symbol` | Batch up to 10 symbols from one file |
| `read_for_edit` | `Read` before `Edit` | Minimal raw code around a symbol — copy directly as `old_string` |
| `read_range` | `Read` offset | Specific line range |
| `read_section` | `Read` | Section by heading (Markdown) or key (YAML/JSON/CSV) |
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
| `session_snapshot` | Compact markdown snapshot (<200 tokens) of goal, decisions, facts, blockers, next step. Auto-persisted to `.token-pilot/snapshots/latest.md`; SessionStart surfaces a pointer when recent. |
| `session_budget` | Hook-suppression pressure for this session: saved tokens, burn fraction, effective denyThreshold, time-to-compact projection |
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
token-pilot tool-audit             # Per-tool savings distribution (cumulative across sessions)
token-pilot tool-audit --json      # Same, machine-readable
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

## Ecosystem

Token Pilot sits in a small toolkit of three orthogonal pieces. Each has a single job; none overlaps with another.

```
Agent
  ├─ Read code file          → smart_read / read_symbol    (Token Pilot MCP)
  │                               └→ ast-index              (structural backend)
  ├─ Need a fresh Read?      → force: true                  (Token Pilot MCP)
  ├─ Run code / inspect logs → execute                      (context-mode MCP)
  └─ Bash agent, no MCP?     → ast-index <subcmd>           (CLI binary)
```

| Tool | Role | When it fires |
|------|------|---------------|
| **[Token Pilot](.)** | Enforcement layer — Read hook, MCP structural reads, dedup, snapshots, subagents | Every code Read / Edit / session |
| **[ast-index](https://github.com/defendend/Claude-ast-index-search)** | Structural indexer. Symbols, usages, hierarchy. Used by Token Pilot under the hood; also a standalone CLI for bash-only agents. | Auto-installed by Token Pilot; CLI available as `ast-index` |
| **[context-mode](https://github.com/mksglu/claude-context-mode)** | Sandbox executor — runs shell / python / js, only stdout enters the window. Orthogonal: not for reading source. | Large `Bash` outputs, `execute(language, code)` calls |

**Rules of thumb:**

- Read code → Token Pilot `smart_read` / `read_symbol` (automatic via hook or MCP).
- Execute code that produces big output → context-mode `execute`.
- Bash agent or pre-flight shell command → `ast-index` CLI directly.
- Never all three in `CLAUDE.md` — Token Pilot's `doctor` warns when `CLAUDE.md` exceeds 60 lines for this reason.

`npx token-pilot init` wires Token Pilot + context-mode into `.mcp.json`; ast-index installs on first run. If any single tool is missing, the other two still work standalone.

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
