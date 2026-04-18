# Token Pilot

MCP server that reduces token consumption in AI coding assistants by **up to 90%** via AST-aware lazy file reading.

Instead of dumping entire files into the LLM context, Token Pilot returns structural overviews (classes, functions, signatures, line ranges) and lets the AI load only the specific symbols it needs.

## How It Works

```
Traditional:  Read("user-service.ts")  →  500 lines  →  ~3000 tokens
Token Pilot:  smart_read("user-service.ts")  →  15-line outline  →  ~200 tokens
              read_symbol("UserService.updateUser")  →  45 lines  →  ~350 tokens
              After edit: read_diff("user-service.ts")  →  ~20 tokens
```

**Up to 90% reduction** on large files. Files under 200 lines are returned in full automatically (zero overhead for small files).

### Benchmarks (real data)

Measured on public open-source repos using the regex fallback parser (no ast-index binary). Files ≥50 lines only:

| Repo | Files | Raw Tokens | Outline Tokens | Savings |
|------|------:|----------:|--------------:|--------:|
| [token-pilot](https://github.com/Digital-Threads/token-pilot) (TS) | 55 | 102,086 | 8,992 | **91%** |
| [express](https://github.com/expressjs/express) (JS) | 6 | 14,421 | 193 | **99%** |
| [fastify](https://github.com/fastify/fastify) (JS) | 23 | 50,000 | 3,161 | **94%** |
| [flask](https://github.com/pallets/flask) (Python) | 20 | 78,236 | 7,418 | **91%** |
| **Total** | **104** | **244,743** | **19,764** | **92%** |

> This measures `smart_read` structural outline savings only. Real sessions also benefit from session cache, dedup reminders, `read_symbol` targeted loading, and `read_for_edit` minimal context.
>
> Run the benchmark yourself: `npx tsx scripts/benchmark.ts`

## Why This Approach Works

The biggest source of token waste in AI coding sessions isn't verbose prompts — it's **redundant context**. Every time a model re-reads a file, re-sends conversation history, or loads code it doesn't need, you pay for tokens that add no value.

Token Pilot attacks this at three levels:

1. **Symbol-first reading** — load outlines instead of full files, drill into specific functions on demand. This alone saves 60-90% on most reads.
2. **Context budget control** — `max_tokens` parameter on `smart_read` auto-downgrades output (full → outline → compact) to fit within a token budget per step.
3. **Session state management** — `session_snapshot` captures session state as a compact markdown block (<200 tokens), enabling clean context compaction without losing track of what you're doing.

These aren't theoretical gains. In real sessions, the combination of structural reading + targeted symbol access + session snapshots consistently reduces token usage by 80-90% compared to raw file reads.

## Installation

### Quick Start (recommended)

One command creates `.mcp.json` with token-pilot + context-mode:

```bash
npx -y token-pilot init
```

Safe to run in any project — if `.mcp.json` already exists, only adds missing servers without overwriting existing config.

This generates:

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] },
    "context-mode": { "command": "npx", "args": ["-y", "claude-context-mode"] }
  }
}
```

**That's it.** Restart your AI assistant. Both packages are downloaded automatically, ast-index binary is fetched on first run. No Rust, no Cargo, no manual setup.

### Manual Setup

Add to your `.mcp.json` (project-level or `~/.mcp.json` for global):

```json
{
  "mcpServers": {
    "token-pilot": {
      "command": "npx",
      "args": ["-y", "token-pilot"]
    }
  }
}
```

Works with: **Claude Code**, **Cursor**, **Codex**, **Antigravity**, **Cline**, and any MCP-compatible client.

#### Cursor

Settings → MCP Servers → Add:
- Command: `npx`
- Args: `-y token-pilot`

#### Claude Code

```bash
# Current project only
claude mcp add token-pilot -- npx -y token-pilot

# All projects (global)
claude mcp add --scope user token-pilot -- npx -y token-pilot

# Shared via git (adds to .mcp.json)
claude mcp add --scope project token-pilot -- npx -y token-pilot
```

### From Source

```bash
git clone https://github.com/Digital-Threads/token-pilot.git
cd token-pilot
npm install && npm run build
```

```json
{
  "mcpServers": {
    "token-pilot": {
      "command": "node",
      "args": ["/path/to/token-pilot/dist/index.js"]
    }
  }
}
```

### ast-index (auto-installed)

ast-index is downloaded automatically on first run. If you prefer manual install:

```bash
# Homebrew (macOS / Linux)
brew tap defendend/ast-index && brew install ast-index

# Or via Token Pilot CLI
npx token-pilot install-ast-index
```

### ast-grep (bundled)

[ast-grep](https://ast-grep.github.io/) (`sg`) is included as optional dependency for structural code pattern search via `code_audit(check="pattern")`. Installs automatically with `npm i -g token-pilot`.

### PreToolUse Hook (Claude Code only)

Optional Claude Code hook support:

- blocks unbounded `Read` on large code files (>500 lines) and points the agent to `smart_read`
- adds `read_for_edit` guidance before `Edit`

```bash
npx token-pilot install-hook            # Install
npx token-pilot uninstall-hook          # Remove
```

> **Note:** With v0.7.4+ MCP instructions, the hook is less critical — AI agents already know to prefer Token Pilot tools.

## How AI Agents Know to Use Token Pilot

**No configuration needed.** Token Pilot uses the MCP protocol's `instructions` field to automatically tell AI agents when to use its tools instead of built-in defaults (Read, cat, Grep).

When connected, every MCP client receives rules like:

```
WHEN TO USE TOKEN PILOT (saves up to 80% tokens):
• Reading code files → smart_read (returns structure, not raw content)
• Need one function/class → read_symbol (loads only that symbol)
• Exploring a directory → outline (all symbols in one call)
• Long session? → session_snapshot (capture state before compaction)
...
WHEN TO USE DEFAULT TOOLS (Token Pilot adds no value):
• Regex/pattern search → use Grep/ripgrep, NOT find_usages
• You need exact raw content for copy-paste → use Read
```

This works on **Claude Code, Cursor, Codex, Antigravity**, and any MCP-compatible client — no project-level rules files needed.

### Optional: Project-Level Rules

For more control, you can add rules to your project:

- **Claude Code** → `CLAUDE.md` in project root
- **Cursor** → `.cursorrules` in project root
- **Codex** → `AGENTS.md` in project root

## MCP Tools (21)

### Core Reading

| Tool | Instead of | Description |
|------|-----------|-------------|
| `smart_read` | `Read` | AST structural overview: classes, functions, methods with signatures. Up to 90% savings on large files. Framework-aware: shows HTTP routes, column types, validation rules. `max_tokens` param for budget-constrained sessions. |
| `read_symbol` | `Read` + scroll | Load source of a specific symbol. Supports `Class.method`. `show` param: full/head/tail/outline. |
| `read_symbols` | N x `read_symbol` | Batch read multiple symbols from one file in a single call (max 10). One round-trip instead of N. |
| `read_for_edit` | `Read` before `Edit` | Minimal RAW code around a symbol — copy directly as `old_string` for Edit tool. Batch mode: pass `symbols` array for multiple edit contexts. |
| `read_range` | `Read` offset | Read a specific line range from a file. |
| `read_diff` | re-`Read` | Show only changed hunks since last smart_read. Requires smart_read before editing (for baseline). Works with any edit tool. |
| `smart_read_many` | multiple `Read` | Batch smart_read for up to 20 files in one call. |

### Search & Navigation

| Tool | Instead of | Description |
|------|-----------|-------------|
| `find_usages` | `Grep` (refs) | All usages of a symbol: definitions, imports, references. Filters: `scope`, `kind`, `lang`, `limit`. Use `context_lines` to include surrounding source code. |
| `project_overview` | `ls` + explore | Dual-detection (ast-index + config files) with confidence scoring. Project type, frameworks, quality tools, CI, architecture, directory map. Filter sections with `include`. |
| `related_files` | manual explore | Import graph: what a file imports, what imports it, test files. |
| `outline` | multiple `smart_read` | Compact overview of all code files in a directory. One call instead of 5-6. Supports `recursive` mode with `max_depth` for deep exploration. |
| `find_unused` | manual | Detect dead code — unused functions, classes, variables. |
| `code_audit` | multiple `Grep` | Code quality issues in one call: TODO/FIXME comments, deprecated symbols, structural code patterns (via ast-grep), decorator search. |
| `module_info` | manual analysis | Module dependency analysis: dependencies, dependents, public API, unused deps. Use for architecture understanding and dependency cleanup. |
| `smart_diff` | raw `git diff` | Structural diff with AST symbol mapping — shows which functions/classes changed instead of raw patch. Affected symbols summary at top. Scopes: unstaged, staged, commit, branch. |
| `explore_area` | outline + related_files + git log | One-call directory exploration: structure, imports, tests, recent changes. Replaces 3-5 separate calls. |
| `smart_log` | raw `git log` | Structured commit history with category detection (feat/fix/refactor/docs), file stats, author breakdown. Filters by path and ref. |
| `test_summary` | raw test output | Run tests and get structured summary: total/passed/failed + failure details. Supports vitest, jest, pytest, phpunit, go, cargo, rspec, mocha. |

### Session & Analytics

| Tool | Description |
|------|-------------|
| `session_snapshot` | Capture session state as a compact markdown block (<200 tokens): goal, decisions (with reasoning), confirmed facts, relevant files, blockers, next step. Decisions field prevents revisiting rejected approaches after compaction. |
| `session_analytics` | Token savings report: total saved, per-tool breakdown, top files, per-intent breakdown, decision insights, policy advisories. |

## CLI Commands

```bash
token-pilot                      # Start MCP server (uses cwd as project root)
token-pilot /path/to/project     # Start with specific project root
token-pilot init [dir]           # Create/update .mcp.json (token-pilot + context-mode)
token-pilot install-ast-index    # Download ast-index binary (auto on first run)
token-pilot install-hook [root]  # Install PreToolUse hook
token-pilot uninstall-hook       # Remove hook
token-pilot hook-read <file>     # Hook handler (called by Claude Code)
token-pilot hook-edit            # Edit hook handler (called by Claude Code)
token-pilot doctor               # Run diagnostics (ast-index, config, updates)
token-pilot install-agents       # Install tp-* subagents (prompts for scope)
token-pilot install-agents --scope=user     # …or into ~/.claude/agents
token-pilot install-agents --scope=project  # …or into ./.claude/agents
token-pilot install-agents --force          # Overwrite user-edited agents
token-pilot uninstall-agents --scope=user|project
token-pilot bless-agents         # Add token-pilot MCP to third-party agents
token-pilot unbless-agents <name>... | --all
token-pilot stats                # Summarise hook-events.jsonl (totals + top files)
token-pilot stats --session[=<id>]          # Filter to one session (most recent if no id)
token-pilot stats --by-agent     # Group savings by agent_type
token-pilot --version            # Show version
token-pilot --help               # Show help
```

### Environment variables

| Var | Effect |
|-----|--------|
| `TOKEN_PILOT_MODE=off` | Disable the PreToolUse hook for this process. |
| `TOKEN_PILOT_BYPASS=1` | Pass every Read through (no summaries). |
| `TOKEN_PILOT_DENY_THRESHOLD=<n>` | Override `hooks.denyThreshold` (positive int). |
| `TOKEN_PILOT_DEBUG=1` | Verbose hook logging to stderr. |
| `TOKEN_PILOT_NO_AGENT_REMINDER=1` | Suppress the MCP-startup install-agents reminder. |
| `TOKEN_PILOT_SUBAGENT=1` | Marks the MCP server as running inside a subagent; skips the reminder. |

## Configuration

Create `.token-pilot.json` in your project root to customize behavior:

```json
{
  "smartRead": {
    "smallFileThreshold": 200,
    "advisoryReminders": true
  },
  "cache": {
    "maxSizeMB": 100,
    "watchFiles": true
  },
  "git": {
    "watchHead": true,
    "selectiveInvalidation": true
  },
  "contextMode": {
    "enabled": "auto",
    "adviseDelegation": true,
    "largeNonCodeThreshold": 200
  },
  "policies": {
    "preferCheapReads": true,
    "maxFullFileReads": 10,
    "warnOnLargeReads": true,
    "largeReadThreshold": 2000,
    "requireReadForEditBeforeEdit": true
  },
  "display": {
    "showImports": true,
    "showDocs": true,
    "maxDepth": 2,
    "showTokenSavings": true
  },
  "ignore": [
    "node_modules/**",
    "dist/**",
    ".git/**"
  ]
}
```

All fields are optional — sensible defaults are used for anything not specified.

### Key Config Options

| Option | Default | Description |
|--------|---------|-------------|
| `smartRead.smallFileThreshold` | `200` | Files with fewer lines are returned in full (no AST overhead). |
| `cache.maxSizeMB` | `100` | Max memory for file cache. LRU eviction when exceeded. |
| `cache.watchFiles` | `true` | Auto-invalidate cache on file changes (chokidar). |
| `git.watchHead` | `true` | Watch `.git/HEAD` for branch switches, invalidate changed files. |
| `contextMode.enabled` | `"auto"` | Detect context-mode plugin. `true`/`false` to force. |
| `contextMode.adviseDelegation` | `true` | Suggest context-mode for large non-code files. |
| `policies.preferCheapReads` | `true` | Advisory hints when expensive tool used where cheaper exists. |
| `policies.maxFullFileReads` | `10` | Warn after N full-file reads in session. |
| `policies.warnOnLargeReads` | `true` | Warn when single response exceeds threshold. |
| `policies.largeReadThreshold` | `2000` | Token threshold for large read warning. |

## Integration with context-mode

Token Pilot is **complementary** to [claude-context-mode](https://github.com/mksglu/claude-context-mode):

| Responsibility | Token Pilot | context-mode |
|----------------|-------------|--------------|
| Code files (.ts, .py, .rs, ...) | AST-level structural reading | - |
| Shell output (npm test, git log) | - | Sandbox + BM25 |
| Large data files (JSON, CSV, logs) | Structural summary | Deep BM25-indexed analysis |
| Re-reads of unchanged files | Compact reminders (~20 tokens) | - |

When both are configured, Token Pilot automatically:
- Detects context-mode via `.mcp.json`
- Suggests context-mode for large non-code files
- Shows combined architecture info in `session_analytics`

**Combined savings: up to 90%** in a typical coding session.

## Supported Languages

Token Pilot supports all 29 languages that [ast-index](https://github.com/defendend/Claude-ast-index-search) supports:

TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, Swift, Objective-C, C#, C++, C, PHP, Ruby, Scala, Dart, Lua, Shell/Bash, SQL, R, Vue, Svelte, Perl, Groovy, Elixir, Common Lisp, Matlab, Protocol Buffers, BSL (1C:Enterprise)

Plus structural summaries for non-code files: JSON, YAML, Markdown, TOML, XML, CSV.

## Troubleshooting

### Verify installation

```bash
npx token-pilot --help          # Should print CLI help
npx token-pilot --version       # Should print current version
npx token-pilot doctor          # Run diagnostics (checks ast-index, config, etc.)
```

### Common issues

| Problem | Fix |
|---------|-----|
| `smart_read` returns full file content (no savings) | ast-index not found. Run `npx token-pilot install-ast-index` |
| `command not found: token-pilot` | Use `npx -y token-pilot` (npx downloads automatically) |
| MCP server doesn't start in Claude Code | Check `claude mcp list` — server should be listed. Restart Claude Code after adding. |
| ast-index binary not found | Run `npx token-pilot doctor` to diagnose. Try `npx token-pilot install-ast-index` to re-download. |

### Updating

`npx -y token-pilot` always fetches the latest version from npm. To force a clean update:

```bash
npx clear-npx-cache              # Clear npx cache
npx -y token-pilot --version     # Verify new version
```

Token Pilot also checks for updates on startup and logs a notice to stderr if a newer version is available.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run dev          # TypeScript watch mode
```

## Architecture

```
src/
  index.ts              — CLI entry point and server bootstrap
  server.ts             — MCP server setup, tool definitions, instructions
  types.ts              — Core domain types
  ast-index/
    client.ts           — ast-index CLI wrapper (22+ methods)
    binary-manager.ts   — Auto-download & manage ast-index binary
    tar-extract.ts      — Minimal tar extractor (zero deps)
    types.ts            — ast-index response types (20+ interfaces)
  core/
    file-cache.ts       — LRU file cache with staleness detection
    context-registry.ts — Advisory context tracking + compact reminders
    symbol-resolver.ts  — Qualified symbol resolution
    token-estimator.ts  — Token count estimation
    session-analytics.ts — Token savings tracking with intent + decision trace
    validation.ts       — Input validators for all tools
    format-duration.ts  — Shared duration formatter
    project-detector.ts — Config-based project detection (frameworks, CI, quality tools)
    confidence.ts       — Confidence metadata for response completeness
    intent-classifier.ts — Tool → intent mapping (edit/debug/explore/review/analyze/search/read)
    budget-planner.ts   — Advisory: suggests cheaper tool alternatives
    decision-trace.ts   — Per-call instrumentation (cost, context state, alternatives)
    session-cache.ts    — Tool-result-level caching with invalidation
    architecture-fingerprint.ts — Cross-session architecture caching
    policy-engine.ts    — Configurable team policies for consistent savings
  config/
    loader.ts           — Config loading + deep merge
    defaults.ts         — Default config values
  formatters/
    structure.ts        — AST outline → text formatter
  handlers/
    smart-read.ts       — smart_read handler
    read-symbol.ts      — read_symbol handler
    read-range.ts       — read_range handler
    read-diff.ts        — read_diff handler (O(n) diff)
    smart-read-many.ts  — Batch smart_read
    find-usages.ts      — find_usages handler (scope/kind/lang/limit filters)
    read-for-edit.ts    — read_for_edit handler (minimal edit context)
    related-files.ts    — related_files handler (import graph)
    outline.ts          — outline handler (recursive directory overview)
    find-unused.ts      — find_unused handler
    code-audit.ts       — code_audit handler (TODOs, deprecated, patterns)
    project-overview.ts — project_overview (dual-detection + confidence)
    module-info.ts      — module_info handler (deps, dependents, API, unused)
    smart-diff.ts       — smart_diff handler (structural git diff + symbol mapping)
    explore-area.ts     — explore_area handler (outline + imports + tests + changes)
    smart-log.ts        — smart_log handler (structured git log + category detection)
    test-summary.ts     — test_summary handler (run tests + parse output)
    non-code.ts         — JSON/YAML/MD/TOML structural summaries
  git/
    watcher.ts          — Git HEAD watcher (branch switch detection)
    file-watcher.ts     — File system watcher (cache invalidation)
  hooks/
    installer.ts        — Hook install/uninstall for Claude Code
  integration/
    context-mode-detector.ts — context-mode presence detection
```

## Credits

Token Pilot is built on top of these excellent open-source projects:

- **[ast-index](https://github.com/defendend/Claude-ast-index-search)** by [@defendend](https://github.com/defendend) — Rust-based AST indexing engine with tree-sitter, SQLite FTS5, and support for 29 programming languages. Token Pilot uses it as the backend for all code analysis.
- **[claude-context-mode](https://github.com/mksglu/claude-context-mode)** by [@mksglu](https://github.com/mksglu) — Complementary MCP plugin for shell output and data file processing via sandbox + BM25. Token Pilot integrates with it for maximum combined savings.
- **[Model Context Protocol](https://modelcontextprotocol.io/)** by Anthropic — The protocol that makes all of this possible.

## License

MIT
