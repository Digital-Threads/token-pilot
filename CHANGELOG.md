# Changelog

All notable changes to Token Pilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-03-02

### Added
- **Auto-install PreToolUse hook**: hook installs automatically on server start (Claude Code), no manual `install-hook` needed
- **AI instructions template**: README includes ready-to-copy block for `.cursorrules` / `CLAUDE.md`

### Changed
- **Tool descriptions rewritten** — explicit "ALWAYS use instead of Read/cat", "use instead of Grep" for AI prioritization
- README updated: PreToolUse hook section, MCP Tools table with "Instead of" column

## [0.4.0] - 2026-03-02

### Added
- **Python class method parser**: smart_read/read_symbol shows all methods inside Python classes with visibility, decorators, async detection
- **PHP class method parser**: same for PHP classes with public/private/protected, static
- **Version display**: `project_overview` and `session_analytics` show `TOKEN PILOT v{version}`

### Changed
- **Removed find_callers** — did not save tokens vs grep, ast-index limitation with `this.method()` calls
- **Removed find_implementations** — did not save tokens vs grep, ast-index limitation with decorators
- **Removed class_hierarchy** — did not save tokens vs grep, poor results from ast-index
- **14 focused tools** instead of 17 — only tools that actually save tokens or provide unique value

### Fixed
- **Mega-symbol truncation**: symbols >300 lines show head (50) + tail (30) + method outline instead of 71KB overflow
- **Recursive findFlat**: unqualified method names (`run`, `_build_summary`) found inside class children

## [0.3.2] - 2026-03-01

### Fixed
- **Python class methods**: smart_read now shows all methods inside Python classes (ast-index only returns class-level, token-pilot parses `def` methods with visibility, decorators, async detection)
- **read_symbol Python**: `Orchestrator.run`, `Orchestrator._build_summary` — qualified and unqualified method access works (was returning entire 829-line class)
- **Mega-symbol truncation**: symbols >300 lines show head (50) + tail (30) + method outline instead of 71KB overflow
- **findFlat recursive**: unqualified method names (`run`, `_build_summary`) now found inside class children

## [0.3.1] - 2026-03-01

### Fixed
- **find_usages**: combine `refs` + `search` with exact word boundary filtering — 0% result loss vs grep (was 40% loss with refs-only)
- **read_symbol**: fix `Class.method` qualified names for flat outlines (ast-index lists methods as siblings, not children)
- **read_symbol**: filter ast-index leaf name fallback by requested file (was returning symbols from wrong files)
- **YAML smart_read**: 3-level nested parser with scalar values, array counts (was only showing top-level keys)
- Removed all "Use Grep as fallback" hints — token-pilot gives complete results on its own

## [0.3.0] - 2026-03-01

### Added
- **find_callers** tool — find all callers of a function, with optional call hierarchy tree (depth parameter)
- **changed_symbols** tool — show symbol-level git changes (added/modified/removed) vs a base branch
- **find_unused** tool — detect potentially unused/dead symbols in the project
- 8 new ast-index client methods: `refs`, `map`, `conventions`, `callers`, `callTree`, `changed`, `unusedSymbols`, `fileImports`
- Incremental index updates via `ast-index update` (fast) instead of full rebuild

### Fixed
- **find_usages**: rewritten to use `ast-index refs` — returns definitions + imports + usages in one call (was losing ~66% of results)
- **project_overview**: rewritten to use `ast-index map` + `conventions` — shows architecture, frameworks, naming patterns, directory map with symbol kinds
- **search_code**: deduplication of results (removes duplicate file:line entries)
- **read_symbol**: structure-first lookup for `Class.method` qualified names with ast-index leaf fallback
- **export_ast_index**: `all_indexed=true` option exports all files from ast-index, not just cached ones
- **YAML smart_read**: expand one level of nesting (shows nested keys under top-level sections)

### Changed
- Total MCP tools: 14 → 17
- ast-index commands used: 8 → 16
- Index updates are now incremental by default (falls back to full rebuild only when needed)

## [0.2.4] - 2026-03-01

### Fixed
- **search_code**: filter out garbage entries with empty file paths or `:undefined` lines
- **read_symbol**: support `Class.method` and `Class::method` qualified names (structure-first lookup, ast-index leaf fallback)
- **export_ast_index**: `all_indexed=true` option exports all files from ast-index, not just cached ones
- **YAML smart_read**: expand one level of nesting (shows service names, nested keys under top-level sections)
- Improved empty-cache message in export_ast_index with hint about `all_indexed`

## [0.2.3] - 2026-03-01

### Fixed
- **ensureIndex**: plain rebuild first (indexes full monorepo), fallback to `--sub-projects` only if <5 files
- **smart_read**: non-code files (YAML, JSON, Markdown, TOML) use structural summary instead of raw content dump
- **smart_read**: unsupported files return truncated 60-line preview instead of full raw content
- **class_hierarchy**: proper parser for ast-index text output (Parents/Children sections)
- **project_overview**: uses directory name when package.json has no `name` field

## [0.2.2] - 2026-03-01

### Fixed
- Published 0.2.1 contained stale Haiku files in dist/ (tsc doesn't clean old outputs)
- Added `prebuild` script (`rm -rf dist`) to prevent stale artifacts
- Added `chmod +x` in prepublishOnly to ensure bin is executable

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
