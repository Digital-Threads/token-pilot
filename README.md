# Token Pilot

**Token-efficient AI coding, enforced.** Cuts context consumption in AI coding assistants by up to **90%** without changing the way you work.

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

- **22 MCP tools** — structural reads, symbol search, git analysis, session analytics → [tools reference](docs/tools.md)
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

| Tool | Role |
|------|------|
| **Token Pilot** | Enforcement layer — hooks, MCP structural reads, subagents |
| **[ast-index](https://github.com/defendend/Claude-ast-index-search)** | Structural indexer. Auto-installed by Token Pilot; also a standalone CLI for bash-only agents |
| **[context-mode](https://github.com/mksglu/claude-context-mode)** | Sandbox executor — runs shell/python/js, only stdout enters the context window |

Rules of thumb: read code → `smart_read`/`read_symbol`; execute code with big output → context-mode `execute`; bash-only agent → `ast-index` CLI. Never copy all three into `CLAUDE.md` — Token Pilot's `doctor` warns when `CLAUDE.md` exceeds 60 lines.

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, C/C++, PHP, Ruby. Non-code (JSON/YAML/Markdown/TOML) gets structural summaries. Regex fallback handles most other languages.

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
