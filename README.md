# Token Pilot

MCP server that reduces token consumption in AI coding assistants by **80-95%** via AST-aware lazy file reading.

Instead of dumping entire files into the LLM context, Token Pilot returns structural overviews (classes, functions, signatures, line ranges) and lets the AI load only the specific symbols it needs.

## How It Works

```
Traditional:  Read("user-service.ts")  →  500 lines  →  ~3000 tokens
Token Pilot:  smart_read("user-service.ts")  →  15-line outline  →  ~200 tokens
              read_symbol("UserService.updateUser")  →  45 lines  →  ~350 tokens
              After edit: read_diff("user-service.ts")  →  ~20 tokens
```

**93% reduction** in this example. Files under 80 lines are returned in full automatically (no overhead for small files).

## Installation

### npx — Any AI Assistant (Cursor, Cline, Continue, etc.)

Zero install. Add to your `.mcp.json` (project-level or `~/.mcp.json` for global):

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

**That's it.** npx downloads the package, ast-index binary is fetched automatically on first run. No Rust, no Cargo, no manual setup.

#### Cursor

Settings → MCP Servers → Add:
- Command: `npx`
- Args: `-y token-pilot`

### Claude Code — Plugin (recommended)

```bash
claude mcp add token-pilot -- npx -y token-pilot
```

This registers the MCP server + PreToolUse hook that auto-suggests `smart_read` for large files.

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

### PreToolUse Hook (optional)

Intercepts `Read` calls for large code files and suggests `smart_read`:

```bash
npx token-pilot install-hook            # Current project
npx token-pilot uninstall-hook          # Remove
```

## MCP Tools (14)

### Core Reading

| Tool | Description |
|------|-------------|
| `smart_read` | AST-based structural overview of a file. Returns classes, functions, methods with signatures and line ranges. |
| `read_symbol` | Load source code of a specific symbol (e.g., `UserService.updateUser`). |
| `read_range` | Read a specific line range from a file. |
| `read_diff` | Show only what changed since Token Pilot last served the file. |
| `smart_read_many` | Batch `smart_read` for up to 20 files in one call. |

### Search & Navigation

| Tool | Description |
|------|-------------|
| `search_code` | Indexed structural code search via ast-index. Faster than grep for symbols. |
| `find_usages` | Find all usages of a symbol across the project (definitions, calls, imports, references). |
| `find_implementations` | Find all implementations of an interface/abstract class/trait. |
| `class_hierarchy` | Show class/interface inheritance hierarchy tree. |
| `project_overview` | Compact project overview: type, dependencies, structure map. |

### Integration & Analytics

| Tool | Description |
|------|-------------|
| `export_ast_index` | Export AST data as markdown/JSON for cross-tool indexing (e.g., context-mode BM25). |
| `session_analytics` | Token savings report: total saved, per-tool breakdown, top files. |
| `context_status` | Show what files/symbols are currently tracked in context. |
| `forget` | Remove a file or symbol from context tracking. |

## CLI Commands

```bash
token-pilot                      # Start MCP server (uses cwd as project root)
token-pilot /path/to/project     # Start with specific project root
token-pilot install-ast-index    # Download ast-index binary (auto on first run)
token-pilot install-hook [root]  # Install PreToolUse hook
token-pilot uninstall-hook       # Remove hook
token-pilot hook-read <file>     # Hook handler (called by Claude Code)
token-pilot --help               # Show help
```

## Configuration

Create `.token-pilot.json` in your project root to customize behavior:

```json
{
  "smartRead": {
    "smallFileThreshold": 80,
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
| `smartRead.smallFileThreshold` | `80` | Files with fewer lines are returned in full (no AST overhead). |
| `cache.maxSizeMB` | `100` | Max memory for file cache. LRU eviction when exceeded. |
| `cache.watchFiles` | `true` | Auto-invalidate cache on file changes (chokidar). |
| `git.watchHead` | `true` | Watch `.git/HEAD` for branch switches, invalidate changed files. |
| `contextMode.enabled` | `"auto"` | Detect context-mode plugin. `true`/`false` to force. |
| `contextMode.adviseDelegation` | `true` | Suggest context-mode for large non-code files. |

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
- Provides `export_ast_index` to feed AST data into context-mode's BM25 index

**Combined savings: ~80%** in a typical coding session.

## Supported Languages

Token Pilot supports all 23 languages that [ast-index](https://github.com/defendend/Claude-ast-index-search) supports:

TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, Swift, C#, C++, C, PHP, Ruby, Scala, Dart, Lua, Shell/Bash, SQL, R, Vue, Svelte, Perl, Groovy

Plus structural summaries for non-code files: JSON, YAML, Markdown, TOML, XML, CSV.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests (111 tests)
npm run test:watch   # Run tests in watch mode
npm run dev          # TypeScript watch mode
```

## Architecture

```
src/
  index.ts              — CLI entry point (5 commands)
  server.ts             — MCP server (14 tools)
  types.ts              — Core domain types
  ast-index/
    client.ts           — ast-index CLI wrapper
    binary-manager.ts   — Auto-download & manage ast-index binary
    tar-extract.ts      — Minimal tar extractor (zero deps)
    types.ts            — ast-index response types
  core/
    file-cache.ts       — LRU file cache with staleness detection
    context-registry.ts — Advisory context tracking + compact reminders
    symbol-resolver.ts  — Qualified symbol resolution
    token-estimator.ts  — Token count estimation
    session-analytics.ts — Token savings tracking
    validation.ts       — Input validators for all tools
    format-duration.ts  — Shared duration formatter
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
    search-code.ts      — search_code handler
    find-usages.ts      — find_usages handler
    find-implementations.ts
    class-hierarchy.ts
    project-overview.ts
    non-code.ts         — JSON/YAML/MD/TOML structural summaries
    export-ast-index.ts — AST export for context-mode BM25
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

- **[ast-index](https://github.com/defendend/Claude-ast-index-search)** by [@defendend](https://github.com/defendend) — Rust-based AST indexing engine with tree-sitter, SQLite FTS5, and support for 23 programming languages. Token Pilot uses it as the backend for all code analysis.
- **[claude-context-mode](https://github.com/mksglu/claude-context-mode)** by [@mksglu](https://github.com/mksglu) — Complementary MCP plugin for shell output and data file processing via sandbox + BM25. Token Pilot integrates with it for maximum combined savings.
- **[Model Context Protocol](https://modelcontextprotocol.io/)** by Anthropic — The protocol that makes all of this possible.

## License

MIT
