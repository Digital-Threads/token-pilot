# Changelog

All notable changes to Token Pilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-03-01

### Fixed
- **RC3**: `search_code` now merges all ast-index result types (content_matches + symbols + files + references) — previously only used content_matches which was often empty
- **RC4**: `class_hierarchy` and `implementations` parse text format as fallback when JSON parse fails
- **RC6**: `read_symbol` auto-fetches outline from ast-index if no cached structure — no longer requires prior smart_read
- `ensureIndex` uses `--sub-projects` flag for monorepo indexing

### Removed
- Reverted Haiku v0.2.1 — removed broken PersistentFileCache, DiffEngine, RealTokenEstimator, ContextWindowTracker, smart-read-xml, context-markup
- Removed 3 heavy native dependencies: `better-sqlite3`, `js-tiktoken`, `diff`

### Added
- `start.sh` — bootstrap script for Claude Code plugin system

## [0.2.0] - 2026-03-01

### Fixed
- **P0**: ast-index errors no longer silently swallowed — all search/usages/implementations/hierarchy/outline/symbol log errors to stderr
- **P0**: `exec()` now captures and logs ast-index subprocess stderr
- **P0**: `projectRoot` detected via `git rev-parse --show-toplevel` instead of `process.cwd()` (fixes wrong index root)
- **P1**: `forget(all=true)` now clears both ContextRegistry and FileCache (fixes stale export_ast_index/read_diff after forget)
- **P1**: `forget(path=X)` also invalidates FileCache for that path
- **P2**: `read_symbol` supports PHP `::` separator (e.g. `RefundProcessor::refund`)
- **P2**: `findInStructure` recursion fixed — supports 3+ level nesting (Namespace::Class::method)
- `ensureIndex()`: verify index has content after `stats` — force rebuild if 0 files indexed

### Changed
- `project_overview`: now shows directory listing + ast-index stats (files, symbols, references) instead of stub
- `project_overview`: added PHP (`composer.json`) detection

## [0.1.6] - 2026-03-01 (unpublished)

### Fixed
- `ensureIndex()`: verify index has content after `stats` — force rebuild if 0 files indexed (fixes empty search results on first run)

## [0.1.5] - 2026-03-01

### Fixed
- PreToolUse hook: read file path from stdin (Claude Code hook format) instead of `$FILE_PATH` env var
- Hook now auto-suggests `smart_read` for large code files when Claude tries to use `Read`
- `session_analytics`: now tracks all tools (read_symbol, read_range, read_diff, smart_read_many, search_code, find_usages, find_implementations, class_hierarchy) — previously only tracked smart_read
- Empty search/usages/implementations results now show diagnostic hints (ast-index status, fallback suggestions)
- `ensureIndex()` now logs build progress and errors to stderr

## [0.1.4] - 2026-03-01

### Fixed
- Lazy file watcher: watch only loaded files instead of entire project root (fixes crash on Docker volumes, home dir, WSL)

## [0.1.3] - 2026-03-01

### Fixed
- Chokidar file watcher error handler (partial fix, superseded by 0.1.4)

## [0.1.2] - 2026-03-01

### Fixed
- ast-index integration: `outline` now parses text output (JSON format not supported in v3.24.0)
- ast-index `symbol` response: handle array format, normalize field names (`line`→`start_line`, `path`→`file`)
- ast-index `search` response: handle `{content_matches: [...]}` wrapper
- ast-index `usages` response: map `context`→`text`, `path`→`file`
- Server version now read dynamically from package.json

### Added
- `token-pilot doctor` — diagnostics command (checks ast-index, Node.js, config, updates)
- `token-pilot --version` — print current version
- Update check on server startup (non-blocking, logs to stderr)
- `/mcp add` installation method documented for Claude Code chat
- Troubleshooting section in README

## [0.1.1] - 2026-03-01

### Added
- `npx -y token-pilot` — zero-install for any MCP client (Cursor, Cline, Continue, etc.)
- Claude Code plugin marketplace support (`.claude-plugin/marketplace.json`)
- `start.sh` bootstrap script — auto `npm install` + `npm run build` on first run
- `npm publish` ready (`files` field, `prepublishOnly` script)
- Universal install instructions in README for Claude Code, Cursor, Cline

### Changed
- `.mcp.json` now uses `start.sh` for reliable bootstrap
- README reorganized: npx as primary install, from-source as fallback

## [0.1.0] - 2026-03-01

### Added

- **Core Reading Tools**: `smart_read`, `read_symbol`, `read_range`, `read_diff`, `smart_read_many`
  - AST-based structural overviews saving 80-95% tokens
  - Small file pass-through (< 80 lines returned in full)
  - O(n) diff algorithm for re-reads
  - Advisory context registry with compact reminders
- **Search & Navigation**: `search_code`, `find_usages`, `find_implementations`, `class_hierarchy`, `project_overview`
  - Powered by ast-index (tree-sitter + SQLite FTS5)
  - Cross-file symbol resolution
- **Context Management**: `session_analytics`, `context_status`, `forget`
  - Token savings tracking per tool and per file
  - Advisory (non-blocking) context tracking
- **Integration**: `export_ast_index`
  - context-mode detection and complementary architecture
  - AST data export for BM25 cross-indexing
- **Infrastructure**
  - Git HEAD watcher with selective cache invalidation on branch switch
  - File watcher (chokidar) for automatic cache invalidation
  - LRU file cache with configurable size limit
  - Input validation for all tools (path traversal protection)
  - Auto-download of ast-index binary from GitHub releases
  - PreToolUse hook installer for Claude Code
  - Claude Code plugin format (.claude-plugin/)
  - Non-code structural summaries (JSON, YAML, Markdown, TOML)
  - Configurable via `.token-pilot.json`
