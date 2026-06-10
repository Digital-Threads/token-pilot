# Token Pilot

**Token-efficient AI coding, enforced.** Cuts context consumption in AI coding assistants by up to **90%** without changing the way you work.

> **Why it matters more now:** as frontier models move up in price — Claude's Fable 5 is the most capable (and most expensive-per-token) tier yet — the tokens you *don't* spend reading code are worth more, not less. The savings are in tokens; the value is in tokens × price. Token Pilot keeps the expensive main thread lean so the premium model spends its budget on reasoning, not on re-reading files.

Three layers, each useful on its own, stronger together:

1. **MCP tools** — structural reads (`smart_read`, `read_symbol`, `read_for_edit`, …). Ask for an outline or load one function by name instead of the whole file.
2. **PreToolUse hooks** — intercept heavy native tool calls (`Read` on large files, recursive `Grep`, unbounded `git diff`) and redirect to token-efficient alternatives.
3. **`tp-*` subagents** — Claude Code delegates with MCP-first behaviour and tight response budgets.

## How It Works

```
Traditional:  Read("user-service.ts")  →  500 lines  →  ~3000 tokens
Token Pilot:  smart_read("user-service.ts")  →  15-line outline  →  ~200 tokens
              read_symbol("UserService.updateUser")  →  45 lines  →  ~350 tokens
              After edit: read_diff("user-service.ts")  →  ~20 tokens
```

Files under 200 lines are returned in full — zero overhead for small files.

### Benchmarks

Measured on public open-source repos. Files ≥50 lines only:

| Repo | Files | Raw Tokens | Outline Tokens | Savings |
|------|------:|----------:|--------------:|--------:|
| [token-pilot](https://github.com/Digital-Threads/token-pilot) (TS) | 55 | 102,086 | 8,992 | **91%** |
| [express](https://github.com/expressjs/express) (JS) | 6 | 14,421 | 193 | **99%** |
| [fastify](https://github.com/fastify/fastify) (JS) | 23 | 50,000 | 3,161 | **94%** |
| [flask](https://github.com/pallets/flask) (Python) | 20 | 78,236 | 7,418 | **91%** |
| **Total** | **104** | **244,743** | **19,764** | **92%** |

> `smart_read` outline savings only. Real sessions additionally benefit from session cache, `read_symbol`, and `read_for_edit`. Reproduce: `npx tsx scripts/benchmark.ts`.

## Quick Start

```bash
npx -y token-pilot init
```

Creates (or merges into) `.mcp.json` with `token-pilot` + [`context-mode`](https://github.com/mksglu/claude-context-mode), then prompts to install `tp-*` subagents. Restart your AI assistant to activate.

## What You Get

- **23 MCP tools** — structural reads, symbol search, git analysis, module routing, session analytics → [tools reference](docs/tools.md)
- **PreToolUse hooks** — block heavy `Grep`/`Bash`/`Read` calls; redirect to efficient alternatives → [hooks & modes](docs/hooks.md)
- **25 `tp-*` subagents** (Claude Code only) — MCP-first delegates with haiku/sonnet model tiers and budget enforcement → [agents reference](docs/agents.md)
- **Tool profiles** — trim advertised `tools/list` to save ~2 k tokens per session → [profiles & config](docs/configuration.md)

## Client Support Matrix

| Client | MCP tools | PreToolUse hooks | `tp-*` subagents |
|--------|:---------:|:----------------:|:----------------:|
| Claude Code | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | ❌ |
| Codex CLI | ✅ | ✅ | ❌ |
| Gemini CLI | ✅ | ✅ | ❌ |
| Cline (VS Code) | ✅ | ✅ | ❌ |
| Antigravity | ✅ | ✅ | ❌ |

Manual config snippets for each client → [installation guide](docs/installation.md)

## Enforcement Mode

`TOKEN_PILOT_MODE` controls how aggressively Token Pilot redirects heavy native tool calls:

| Value | Behaviour |
|-------|-----------|
| `advisory` | Allow all — hooks pass through, advisory notes only |
| `deny` *(default)* | Block heavy `Grep`/`Bash` patterns; intercept large `Read` calls |
| `strict` | Deny + auto-cap MCP output (`smart_read` ≤ 2 000 tokens, `find_usages` → list mode, `smart_log` → 20 commits) |

```bash
TOKEN_PILOT_MODE=strict npx token-pilot
```

→ [Full hook & mode docs](docs/hooks.md)

## Ecosystem

Token Pilot owns **input** tokens — the stuff Claude reads from files, git, search. The other half of a session (what Claude *writes* back, how it executes code, how it remembers state across days) is owned by separate tools. They compose cleanly:

| Tool | Owns | Typical savings |
|------|------|----------------:|
| **Token Pilot** | code reads, git, search | 60-90% input |
| **[caveman](https://github.com/JuliusBrussee/caveman)** | Claude's response prose (terse-speak skill) | ~75% output |
| **[ast-index](https://github.com/defendend/Claude-ast-index-search)** | the structural indexer Token Pilot rides on | foundation |
| **[context-mode](https://github.com/mksglu/claude-context-mode)** | sandboxed shell / python / js execution | 90%+ on big stdout |

A session that pairs `token-pilot` + `caveman` typically hits **~85-90% total reduction** — each cuts a different half, no overlap. Install what you need; none of them assume the others are present.

→ [full ecosystem map](docs/ecosystem.md)

Rules of thumb: read code → `smart_read`/`read_symbol`; execute code with big output → context-mode `execute`; bash-only agent → `ast-index` CLI. Never copy the whole stack into `CLAUDE.md` — Token Pilot's `doctor` warns when `CLAUDE.md` exceeds 60 lines.

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, C/C++, PHP, Ruby. Non-code (JSON/YAML/Markdown/TOML) gets structural summaries. Regex fallback handles most other languages.

## Update / New Machine

**Claude Code (plugin — recommended):**
```bash
# Install on a new machine:
claude plugin marketplace add https://github.com/Digital-Threads/token-pilot
claude plugin install token-pilot@token-pilot

# Update to latest:
claude plugin update token-pilot
```

**Other clients (Cursor, Codex, Cline, …):**
```bash
# Install on a new machine:
npx -y token-pilot init

# Update to latest — npx always pulls fresh, just restart your client.
# Or if installed globally:
npm i -g token-pilot@latest
npx token-pilot install-hook
npx token-pilot install-agents --scope=user --force
```

## Tips for Claude Code 2.1.139+

The May 2026 Claude Code update changed a few things that affect how
token-pilot is invoked. Nothing breaks on older versions — these are
quality-of-life notes for the newer ones.

- **Run a tp-\* agent directly without the `plugin:` prefix.**
  `claude --agent tp-debugger "fix the stack trace"` now works the same
  as `--agent token-pilot:tp-debugger`. The Task tool dispatcher
  resolves the short name automatically.

- **Cold ast-index calls — raise `MCP_TOOL_TIMEOUT`.**
  The first `find_usages` / `outline` / `read_symbol` on a large repo
  triggers an index build. Default per-MCP-tool timeout (60 s) is
  enough for ~50k-file repos; bigger ones benefit from
  `MCP_TOOL_TIMEOUT=120000` in `~/.claude/settings.json`. Subsequent
  calls hit the cache and return in ~50 ms.

- **Background sessions with `--mcp-config`.**
  Dispatching a worker via `claude agents` or `--bg` with
  `--mcp-config /path/to/other.json` swaps the MCP set for that
  session. If `token-pilot` is not in the override config, MCP tools
  (`smart_read`, `find_usages`, …) are unavailable in that worker
  even though the hooks (Read / Edit / Bash / Grep / Task) still
  fire — hooks are project-level, MCP tools are session-level. Add
  `token-pilot` to the override config or skip `--mcp-config`.

- **`claude plugin details token-pilot`.**
  Shows the projected per-turn token cost, the hook event names, and
  the MCP server entry. The skill list, the agent list, and the LSP
  list are all auto-discovered from the canonical sub-folders.

## Power-user — undocumented Claude Code features that pair with token-pilot

These fields come from reverse-engineering `@anthropic-ai/claude-code@2.1.87`
source (see the May 2026 Habr write-up). They work today but are
not in the official Claude Code docs, so use at your own risk.

### Persistent agent memory (`memory: project`)

Every relevant tp-\* agent (onboard, debugger, pr-reviewer,
history-explorer, audit-scanner) now ships with `memory: project`
in its frontmatter. Claude Code persists the agent's working notes
in the project so the agent gets faster on repeat invocations —
`tp-onboard` remembers your layout, `tp-pr-reviewer` remembers your
flagged patterns, etc. v0.35.0+.

### Required MCP gating (`requiredMcpServers`)

Every tp-\* agent declares `requiredMcpServers: ["token-pilot"]`.
Claude Code refuses to load the agent when the MCP server isn't
configured, so a stale install never produces a "tools not found"
loop. v0.35.0+.

### Bootstrap-once hook (`once: true`)

The plugin ships a SessionStart hook flagged `once: true` —
Claude Code runs it once per project then auto-removes the entry.
It surfaces friendly hints when `install-agents` or
`install-ast-index` hasn't been run yet. v0.35.0+.

### Async telemetry (`async: true`)

PostToolUse hooks (Bash, Task) are marked `async: true` so they
no longer add wall-clock to the hot path — telemetry writes fire
in the background.

### Auto-mode permissions (user-side)

If you want full auto-approval for safe commands, the YOLO
classifier reads natural-language environment descriptions:

```json
{
  "autoMode": {
    "allow": ["Bash(git status)", "Bash(npm test)", "Read", "Grep"],
    "soft_deny": ["Bash(git push *)", "Bash(rm *)", "Write(.env)"],
    "environmentDescription":
      "This is a development laptop. Read-only ops are safe; deny anything touching credentials or production."
  }
}
```

token-pilot's enforcement still runs on top (raw Read on large files
is denied first, regardless of autoMode).

### Permission rule syntax cheat-sheet

```
Bash(npm *)                       # wildcard after "npm "
Bash(git commit *)                # specific subcommand
Read(*.ts)                        # extension
Read(src/**/*.ts)                 # recursive + extension
Write(src/**)                     # recursive all files
mcp__token-pilot                  # all token-pilot MCP tools
mcp__token-pilot__smart_read      # one specific MCP tool
```

`*` matches inside word boundaries (shell-glob); `**` is recursive.
The `if` field on hooks uses the same syntax.

### Experimental: transparent Read rewrite

Set `TOKEN_PILOT_HOOK_REWRITE=1` to swap the "deny + suggest" Read
hook behaviour for an `updatedInput` rewrite — Claude Code's
undocumented field that silently bounds the Read to its first 200
lines instead of bouncing the call. The structural summary still
rides along in `additionalContext`. Default OFF because the field
is undocumented and may change.

### Experimental: SubagentStop budget feedback (CC 2.1.163+)

Every subagent completion already lands a task-telemetry row via the
`SubagentStop` hook (that's how `stats --tasks` knows what you
dispatched). With `TOKEN_PILOT_SUBAGENT_FEEDBACK=1` the same hook also
returns `additionalContext` — when a `token-pilot workflow` fan-out is
at ≥90 % of its token ceiling, each completing agent gets a wind-down
note so a hundred-agent `/workflow` run stops before blowing the
budget.

**Requires Claude Code 2.1.163+.** Returning `additionalContext` from
`SubagentStop` is only honoured there; older Claude Code labels it a
hook error. Default OFF for that reason — enable only once
`claude --version` reports 2.1.163 or later.

## What's new for Claude Code 2.1.151+

These notes are about behaviour you'll see automatically once you
update both Claude Code and `token-pilot@latest`. No extra
configuration required.

### Session title badge (`[TP] Nk saved`)

The SessionStart hook now sets the window/tab title to the cumulative
token savings for the current project, using Claude Code 2.1.152's
`hookSpecificOutput.sessionTitle` field. You'll see a badge like
`[TP] 1.2M saved` in the title bar so you can confirm at a glance
that the plugin is doing its job.

### Hardened skills (`disallowed-tools`)

The three bundled skills (`guide`, `install`, `stats`) declare
`disallowed-tools` (Claude Code 2.1.152+) so a runaway model can't
issue `Write` / `Edit` / `Task` while the skill is on display. The
install skill keeps `Bash` because it has to run
`npx token-pilot install-ast-index`; the other two have Bash
disallowed too.

### Auto mode on third-party providers

Claude Code 2.1.158 opened auto mode to Bedrock / Vertex / Foundry
on Opus 4.7 + 4.8. If you're on one of those, opt in with
`CLAUDE_CODE_ENABLE_AUTO_MODE=1`. token-pilot's deny-Read /
deny-Bash gates still run on top — auto mode never bypasses them.

### Opus 4.8 as fast-mode default

Claude Code 2.1.154 made Opus 4.8 the default for high effort. The
tp-* agents that already declared `model: haiku` keep their cheaper
tier (90 %+ of the agent roster); the few sonnet/opus-tier ones
ride the upgrade automatically.

## Fleet workflows (v0.38.0)

When you fan a task across many subagents — via Claude Code's
`/workflow`, the Agent tool, or your own orchestration — token-pilot
can treat the whole run as one budgeted, telemetry-tagged unit.

token-pilot **owns** the workflow boundary, so this works regardless
of whether Claude Code propagates a workflow id. You wrap the batch:

```bash
# Start a workflow — prints an export line you eval into your shell
eval "$(token-pilot workflow start "review every PR from last sprint" --budget=2000000)"

# ...now run your fan-out work. Every hook event is tagged with the
#    workflow id automatically (TOKEN_PILOT_WORKFLOW_ID is set).

token-pilot workflow status      # live budget + task counts
token-pilot workflow list        # all recorded workflows
token-pilot workflow end         # stamp it finished + print summary
```

While a workflow is active:

- Every `event:"task"` / `denied` / `diagnostic` row in
  `hook-events.jsonl` carries `workflow_id`, so you can slice one
  fan-out run out of the global log.
- The PreToolUse:Task hook watches the token ceiling. At ≥90 % it
  appends a wind-down note to its routing advice ("finish in-flight
  work rather than starting new branches") and logs a
  `workflow_near_budget` diagnostic — visible in `workflow status`.
  Dispatch is never hard-blocked on budget (a half-finished fan-out
  is worse than a small overrun).
- The window title switches to `[TP] wf · N tasks · X%` so a long run
  shows live progress.

Claude Code's own `/workflow` (2.1.154+) does **not** expose a
per-workflow id env var to subagents (verified against the 2.1.161
bundle — it has only a `CLAUDE_CODE_WORKFLOWS` feature flag). So
token-pilot's workflows are independent: they rely on our own
`TOKEN_PILOT_WORKFLOW_ID`. If CC adds a per-workflow env var later,
`activeWorkflowId()` already probes for it — no config change needed.

## Troubleshooting

```bash
npx token-pilot doctor          # diagnose: ast-index, config, upstream drift
# "ast-index not found"  →  npx token-pilot install-ast-index
# "hooks not firing"     →  restart your AI assistant
```

## Credits

Built on [ast-index](https://github.com/defendend/ast-index) · [@ast-grep/cli](https://ast-grep.github.io/) · [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [chokidar](https://github.com/paulmillr/chokidar)

## License

MIT
