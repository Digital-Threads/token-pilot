# Changelog

All notable changes to Token Pilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-03-01

### Fixed
- Chokidar file watcher crash on permission-denied files (e.g. Docker volumes, restricted dirs)

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
