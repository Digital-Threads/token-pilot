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

### Claude Code

From inside a Claude Code chat session:

```
/mcp add token-pilot -- npx -y token-pilot
```

Or from the terminal:

```bash
# Current project only
claude mcp add token-pilot -- npx -y token-pilot

# All projects (global)
claude mcp add --scope user token-pilot -- npx -y token-pilot

# Shared via git (adds to .mcp.json)
claude mcp add --scope project token-pilot -- npx -y token-pilot
```

This registers the MCP server. The PreToolUse hook auto-suggests `smart_read` for large files.

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

### PreToolUse Hook (auto-installed for Claude Code)

Intercepts `Read` calls for large code files and suggests `smart_read`. **Installed automatically** when the MCP server starts. Manual commands:

```bash
npx token-pilot install-hook            # Force re-install
npx token-pilot uninstall-hook          # Remove
```

## AI Instructions (Important)

After installing Token Pilot, add these instructions to your project so the AI uses Token Pilot instead of default tools.

**Cursor** — add to `.cursorrules` in project root:

**Claude Code** — add to `CLAUDE.md` in project root:

```
# Token Pilot — Code Reading Rules

You have Token Pilot MCP server connected. ALWAYS use it instead of default tools for reading code:

## Reading files
- ALWAYS use smart_read() instead of Read/cat for code files. It returns AST structure (classes, methods, signatures, line ranges) saving 80-99% tokens.
- After smart_read, use read_symbol("path", "Class.method") to load only the specific function you need.
- Before editing, use read_for_edit("path", symbol="method") to get minimal raw code for Edit's old_string. 97% savings vs full Read.
- Use smart_read_many() instead of multiple Read calls when reading 2+ files.
- After editing a file, use read_diff() instead of re-reading — shows only changed hunks.

## Navigation
- Use outline("src/modules/users/") to see all files in a directory at once — one call instead of 5-6 smart_read.
- Use related_files("file.ts") to see import graph: what it imports, what imports it, test files.
- Use find_usages() instead of Grep when looking for where a symbol is used.

## Workflow
1. project_overview() — start here for unfamiliar projects
2. outline("src/modules/users/") — overview of a module directory
3. smart_read("file.ts") — see structure of a file
4. read_symbol("file.ts", "ClassName.methodName") — read specific code
5. read_for_edit("file.ts", symbol="methodName") — get raw code for editing
6. read_diff("file.ts") — after edits, see only changes
```

## MCP Tools (12)

### Core Reading

| Tool | Instead of | Description |
|------|-----------|-------------|
| `smart_read` | `Read` | AST structural overview: classes, functions, methods with signatures. 80-99% savings. Framework-aware: shows HTTP routes, column types, validation rules. |
| `read_symbol` | `Read` + scroll | Load source of a specific symbol. Supports `Class.method`. `show` param: full/head/tail/outline. |
| `read_for_edit` | `Read` before `Edit` | **NEW.** Minimal RAW code around a symbol — copy directly as `old_string` for Edit. 97% savings. |
| `read_range` | `Read` offset | Read a specific line range from a file. |
| `read_diff` | re-`Read` | Show only what changed since last smart_read. 80-95% savings on re-reads. |
| `smart_read_many` | multiple `Read` | Batch smart_read for up to 20 files in one call. |

### Search & Navigation

| Tool | Instead of | Description |
|------|-----------|-------------|
| `find_usages` | `Grep` (refs) | All usages of a symbol: definitions, imports, references. |
| `project_overview` | `ls` + explore | Project type, architecture, frameworks, directory map. |
| `related_files` | manual explore | **NEW.** Import graph: what a file imports, what imports it, test files. |
| `outline` | multiple `smart_read` | **NEW.** Compact overview of all code files in a directory. One call instead of 5-6. |
| `find_unused` | manual | Detect dead code — unused functions, classes, variables. |

### Analytics

| Tool | Description |
|------|-------------|
| `session_analytics` | Token savings report: total saved, per-tool breakdown, top files. |

## CLI Commands

```bash
token-pilot                      # Start MCP server (uses cwd as project root)
token-pilot /path/to/project     # Start with specific project root
token-pilot install-ast-index    # Download ast-index binary (auto on first run)
token-pilot install-hook [root]  # Install PreToolUse hook
token-pilot uninstall-hook       # Remove hook
token-pilot hook-read <file>     # Hook handler (called by Claude Code)
token-pilot doctor               # Run diagnostics (ast-index, config, updates)
token-pilot --version            # Show version
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

## Troubleshooting

### Verify installation

```bash
npx token-pilot --help          # Should print CLI help with 17 tools
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
  index.ts              — CLI entry point (6 commands)
  server.ts             — MCP server (17 tools)
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
    find-usages.ts      — find_usages handler (via ast-index refs)
    read-for-edit.ts    — read_for_edit handler (minimal edit context)
    related-files.ts    — related_files handler (import graph)
    outline.ts          — outline handler (directory overview)
    find-unused.ts      — find_unused handler
    project-overview.ts — project_overview (via ast-index map + conventions)
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
