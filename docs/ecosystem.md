# Context-Efficient AI Coding — Ecosystem Map

Token Pilot solves **one half** of the context problem: the tokens that come *into* Claude's context from reading code. A full coding session has at least four independent places where tokens pile up — the tools below each own one of them.

Use them together. They compose cleanly and do not overlap.

## Where your tokens actually go

```
┌──────────────────────────────────────────────────────────────────┐
│  A COMPLETE CODING SESSION                                        │
│                                                                   │
│  INPUT side                          OUTPUT side                  │
│  ──────────                          ───────────                  │
│  1. Reading code files               4. Claude's response prose   │
│  2. git diff / log                   5. Chain-of-thought noise    │
│  3. Running shell commands                                        │
│  4. Keeping context across sessions                               │
└──────────────────────────────────────────────────────────────────┘
```

## The stack

| Tool | Owns | Savings | Mechanism |
|------|------|--------:|-----------|
| **[token-pilot](https://github.com/Digital-Threads/token-pilot)** | code reads, git, search | **60-90% input** | MCP tools + PreToolUse hooks |
| **[caveman](https://github.com/JuliusBrussee/caveman)** | Claude's response prose | **~75% output** | System-prompt skill (terse style) |
| **[ast-index](https://github.com/defendend/Claude-ast-index-search)** | code indexing (underlying) | foundation for structural reads | Native Rust indexer |
| **[context-mode](https://github.com/mksglu/claude-context-mode)** | shell / python / js execution | **90%+ on big stdout** | Sandbox — only stdout enters context |
| **[cavemem](https://github.com/JuliusBrussee/cavemem)** | cross-session memory | context across restarts | Persistent structured recall |

**Combined footprint:** a session that spends ~70% on reading code, ~25% on shell output, and ~5% on remembered context could see ~85-90% total reduction when the right tool owns each segment.

## What token-pilot does *not* do

To keep the boundaries clear:

- **token-pilot does not change Claude's response style.** If answers feel long, that's OUTPUT. Install `caveman` for terse-speak.
- **token-pilot does not execute code.** If `npm test` or long `python` output floods your context, install `context-mode`.
- **token-pilot does not remember across sessions.** If you're re-explaining context every morning, install `cavemem`.
- **token-pilot does not index source.** It *uses* ast-index under the hood — installed automatically, but also standalone.

## Installing the full stack

Each tool is independent — install whatever you need.

```bash
# Claude Code (plugin system)
claude plugin marketplace add Digital-Threads/token-pilot
claude plugin install token-pilot@token-pilot

claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman@caveman

# token-pilot bootstraps ast-index automatically.
# context-mode can be installed via its own plugin route.
```

For other clients (Cursor, Codex, Cline, Windsurf, …) each tool has its own install matrix — follow each project's README.

## Why not one meta-plugin?

We considered shipping `ai-coding-savings-pack` that bundles all of them. Tradeoffs:

- **Pro:** one-command install.
- **Con:** blast radius. If any component ships a regression, the whole pack looks broken. Each tool has its own release cadence and support surface; coupling them hides those boundaries.

For now the recommendation is *install what you need, individually*. Revisit bundling after real combined-usage data shows it pays off.

## Measuring the combined effect

Each tool ships its own telemetry, read as-is:

```bash
npx token-pilot tool-audit            # input savings (per tool, cumulative)
npx token-pilot doctor                # ecosystem coverage check — see what's installed
```

The `doctor` command checks which ecosystem tools are active in the current environment and prints gaps. That's the cheapest way to see "am I leaving savings on the table?"

## Credits

Everything listed here is MIT or Apache-licensed open source maintained by small teams. If you use them, please star the repos — all of this is volunteer work.
