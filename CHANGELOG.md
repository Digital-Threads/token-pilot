# Changelog

All notable changes to Token Pilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-03-14

### Added
- **Version check for all components** — on startup, checks token-pilot (npm), ast-index (GitHub releases), and context-mode (npm) in parallel. Non-blocking, fire-and-forget. Shows update notifications in stderr.
- **`autoUpdate` config flag** — `updates.autoUpdate: true` in `.token-pilot.json` auto-downloads new ast-index binary on startup. Default: `false` (notify only). token-pilot and context-mode only notify (separate processes).
- **`checkBinaryUpdate()`** — compares installed ast-index version vs latest GitHub release.
- **`isNewerVersion()` utility** — semver comparison: strip `v` prefix, compare segments. Handles different lengths (`1.0` vs `1.0.1`).
- **Common Lisp extensions** — `.lisp`, `.lsp`, `.cl`, `.asd` added to `CODE_EXTENSIONS` for ast-index v3.28+ compatibility.
- **9 new tests** — `isNewerVersion()` covering major/minor/patch, same version, older, `v` prefix, different segment lengths, large numbers, real-world versions. Total: 217 tests.

### Changed
- **`doctor` command** — now shows 3 sections: token-pilot (installed/latest), ast-index (installed/latest/auto-update status), context-mode (detected/latest npm). Previously only showed ast-index binary status.
- **`install-ast-index` command** — now also updates existing binary if newer version available on GitHub.
- **`printHelp()`** — fixed tool count: 18 (was incorrectly showing 12 since v0.8.0).
- **Startup update check** — replaced single `checkLatestVersion()` with `checkAllUpdates()` covering all 3 components via `Promise.allSettled`.

### Fixed
- **`test_summary` PHPUnit parser** — now counts both `Failures:` and `Errors:` (was only counting failures).
- **`test_summary` cargo parser** — correctly identifies failure name-list section (no `----` markers) vs detail section.
- **`test_summary` token estimation** — uses shared `estimateTokens()` instead of local duplicate.
- **`smart_log` category detection** — `documentation` now matches docs pattern, `tests` (plural) matches test pattern, `optimize`/`optimization` match perf pattern.
- **`explore_area` path boundary** — `startsWith(path + '/')` prevents `src/auth` matching `src/authorize/`.
- **Validation consistency** — `validateSmartLogArgs` and `validateTestSummaryArgs` now use `optionalString`/`optionalNumber` helpers, reject empty strings, check integers.

## [0.11.0] - 2026-03-14

### Added
- **`smart_log` tool** — structured git log with commit category detection (feat/fix/refactor/docs/test/chore/style/perf). Shows author breakdown, file stats (+/-), per-commit file list. Filters by path and ref. Raw git log → compact summary.
- **`test_summary` tool** — runs test command and returns structured summary: total/passed/failed/skipped + failure details. Parsers for vitest, jest, pytest, phpunit, go test, cargo test, rspec, mocha + generic fallback. 200 lines of raw output → 10-15 lines.
- **38 new tests** — smart_log parser (5), categorizer (4), test_summary parsers (17), runner detection (8), validation (4). Total: 208 tests (was 170).

### Changed
- **18 tools** (was 16) — added `smart_log`, `test_summary`
- **MCP instructions** — added smart_log and test_summary to workflow guidance

## [0.10.0] - 2026-03-14

### Added
- **`smart_diff` tool** — structural git diff with AST symbol mapping. Shows which functions/classes were modified/added/removed instead of raw patch output. Supports scopes: `unstaged`, `staged`, `commit` (ref required), `branch` (ref required). Small diffs (<=30 lines) include actual hunks, large diffs show summary. Returns `rawTokens` for precise savings analytics.
- **`explore_area` tool** — one-call directory exploration combining outline + imports + tests + git changes. Replaces 3-5 separate tool calls when starting work on an area. Sections: `outline` (recursive depth 2), `imports` (external deps + who imports this area), `tests` (matching test/spec files), `changes` (recent git log). All sections run in parallel via `Promise.allSettled`.
- **26 new tests** — smart_diff parser (10), symbol mapping (5), validation (11). Total: 170 tests (was 144).

### Changed
- **16 tools** (was 14) — added `smart_diff`, `explore_area`
- **MCP instructions** — updated workflow: `project_overview → explore_area → smart_read → read_symbol → read_for_edit → edit → smart_diff`
- **`outlineDir` and `CODE_EXTENSIONS` exported** from outline.ts for reuse by explore_area

## [0.9.0] - 2026-03-08

### Added
- **`module_info` tool** — analyze module dependencies, dependents, public API, and unused deps. Uses ast-index v3.27.0 module commands (`modules`, `module-deps`, `module-dependents`, `module-api`, `unused-deps`). Includes degradation check when ast-index is unavailable.
- **`project_overview` dual-detection** — shows BOTH ast-index type detection AND config-file detection (package.json, composer.json, Cargo.toml, pyproject.toml, go.mod) with CONFIDENCE scoring (high/medium/low/unknown). Detects frameworks, quality tools (PHPStan, ESLint, Vitest, Jest, Biome, etc.), CI pipelines (GitHub Actions, GitLab CI, Jenkins), and Docker.
- **`project_overview` `include` parameter** — filter sections: `["stack"]` for quick type check, `["quality","ci"]` for tooling overview. Default: all sections.
- **`find_usages` post-filters** — `scope` (path prefix), `kind` (definitions/imports/usages), `lang` (14 languages by extension), `limit` (per category, 1-500). All filters optional, backward compatible.
- **`outline` recursive mode** — `recursive=true` with `max_depth` (default 2, max 5) recurses into subdirectories. At max depth shows file counts only.
- **`src/core/project-detector.ts`** — extracted config-based detection logic into reusable module. Framework detection maps for PHP (7), JS (10), Python (5). Quality tools scanner (13 tools). CI pipeline detector (6 platforms).
- **ast-index client: 5 module methods** — `modules()`, `moduleDeps()`, `moduleDependents()`, `unusedDeps()`, `moduleApi()` with JSON-first + text fallback parsing.
- **ast-index types: 4 module interfaces** — `AstIndexModuleEntry`, `AstIndexModuleDep`, `AstIndexUnusedDep`, `AstIndexModuleApi`.

### Fixed
- **`module_info` token savings** — `tokensWouldBe` was equal to `tokensReturned` (0% savings). Now estimates manual analysis cost correctly.
- **`outline` recursive overflow** — added `MAX_OUTLINE_LINES=500` guard to prevent runaway output on large projects with `recursive=true`.
- **`project_overview` "frontend" label** — removed hardcoded "frontend" suffix for secondary stacks (Node.js is not always frontend).
- **Ruff detection** — no longer double-reads `pyproject.toml`. Checks `ruff.toml`/`.ruff.toml` first, falls back to `pyproject.toml [tool.ruff]` only if needed.
- **44 new tests** — validators (23) + project-detector (21). Total: 144 tests (was 100).

### Changed
- **14 tools** (was 13) — added `module_info`
- **Tool descriptions** — updated with `(v1.1: ...)` version hints for enhanced tools
- **MCP instructions** — added module_info to "COMBINE BOTH" workflow section
- **Version sync** — package.json, plugin.json, marketplace.json all at 0.9.0

## [0.8.3] - 2026-03-08

### Fixed
- **code_audit pattern search — root cause fix** — `ast-index agrep` does not support `--limit` flag. Token Pilot was passing `--limit 50` which caused the command to fail silently, returning 0 results across v0.8.0–v0.8.2. Removed the flag; results are now limited via `.slice()` after parsing.

## [0.8.2] - 2026-03-08

### Fixed
- **code_audit pattern search** — inject `node_modules/.bin` into PATH so `ast-index agrep` can find `sg` (ast-grep) when it's installed as optional dependency but not in system PATH.
- **code_audit annotations** — strip `@` prefix from annotation names (`@Injectable` → `Injectable`). ast-index expects names without `@`.

## [0.8.1] - 2026-03-08

### Added
- **ast-grep auto-install** — `@ast-grep/cli` added as optional dependency. `code_audit(check="pattern")` now works out-of-the-box without manual `brew install ast-grep`.
- **MCP instructions: security audit guidance** — instructions now recommend Grep for security patterns (password, token, secret, credential) and `find_unused` for dead code detection.

### Changed
- **ast-index stats → JSON parsing** — `--format json` for reliable file count extraction instead of regex on text output.

## [0.8.0] - 2026-03-07

### Added
- **`code_audit` tool** — find code quality issues in one call: TODO/FIXME comments (`check="todo"`), deprecated symbols (`check="deprecated"`), structural code patterns via ast-grep (`check="pattern"`), decorator search (`check="annotations"`), or combined audit (`check="all"`).
- **Incremental index update on file changes** — file watcher now triggers `ast-index update` (debounced 2s) after edits. Keeps index fresh for find_usages, find_unused, code_audit.
- **ast-index client methods** — `agrep()`, `todo()`, `deprecated()`, `annotations()`, `incrementalUpdate()`.

### Fixed
- **smart_read on directories** — now returns helpful message instead of EISDIR crash.
- **MCP instructions** — added "COMBINE BOTH" section for audit tasks (Token Pilot + Grep).

## [0.7.6] - 2026-03-07

### Added
- **`npx token-pilot init`** — one command creates `.mcp.json` with both token-pilot and context-mode configured. Idempotent — safely updates existing configs without overwriting.
- **MCP Server Instructions** — protocol-level `instructions` field tells AI agents WHEN to use Token Pilot tools instead of built-in defaults. Works universally on all MCP clients.
- **Improved tool descriptions** — each tool explicitly states what built-in tool it replaces (e.g. "Use INSTEAD OF Read/cat").

### Fixed
- **3 high severity vulnerabilities** — updated hono and express-rate-limit.
- **npm package size** — excluded source maps from package. 505 kB → 286 kB (−43%).
- **Accurate thresholds** — README and instructions now correctly state smallFileThreshold=200 (was 80).
- **read_diff documentation** — clarified that smart_read must be called BEFORE editing to create baseline snapshot.

### Changed
- **README** — honest metrics (60-80%), Quick Start with `init` command, MCP instructions section, Codex/Antigravity support.
- **npm keywords** — added `codex`, `cline`, `model-context-protocol`, `token-savings`.

## [0.7.4] - 2026-03-07

### Added
- **MCP Server Instructions** — protocol-level `instructions` field tells AI agents WHEN to use Token Pilot tools instead of built-in Read/cat/Grep. Works universally on Claude Code, Cursor, Codex, Antigravity, and any MCP-compatible client. Includes rules for when NOT to use Token Pilot (regex search, raw content copy-paste).
- **Improved tool descriptions** — each tool now explicitly states what built-in tool it replaces (e.g. "Use INSTEAD OF Read/cat", "Use INSTEAD OF Grep/ripgrep"). Agents can make informed decisions from description alone, without needing project-level rules files.

## [0.7.3] - 2026-03-07

### Fixed
- **read_diff diagnostic** — when cache miss occurs, now shows resolved absolute path and all cached file paths. This reveals path mismatches between smart_read and read_diff calls (e.g. different relative paths resolving to different absolute paths).

## [0.7.2] - 2026-03-07

### Fixed
- **read_diff on small files** — `smart_read` small-file pass-through (≤150 lines) returned content without caching in fileCache. `read_diff` always showed "No previous read" for small files because the baseline was never stored. Now all files are cached regardless of size.

## [0.7.1] - 2026-03-07

### Fixed
- **read_diff after read_for_edit** — `read_for_edit` now caches the full file content, so `read_diff` can use it as baseline after edits. Previously returned "No previous read" because read_for_edit didn't populate the file cache.
- **outline on intermediate directories** — directories with only subdirectories (no direct code files) now show subdirectory listing with recursive code file counts instead of "No code files found". Enables progressive drill-down: `outline("module/") → outline("module/infrastructure/")`.

## [0.7.0] - 2026-03-07

### Fixed
- **Project root detection** — complete rewrite of how token-pilot discovers the working project:
  1. **MCP roots** (new, primary) — uses MCP protocol `listRoots()` to get workspace root from Claude Code. Works for all tools including `find_usages`, `find_unused`, `project_overview` (no file path needed).
  2. **INIT_CWD/PWD env vars** (new) — when started via `npx`, npm sets `INIT_CWD` to the invoking directory. Catches cases where `process.cwd()` is `/` but the real project root is available in env.
  3. **Git detect from file path** (improved) — now triggers from any tool call args (`path`, `paths`, `file`, `module`), not just `smart_read`.
- **ast-index tools always disabled** — `find_usages`, `find_unused`, `project_overview` never triggered auto-detect because they have no `path` argument. Now all tools trigger detection via MCP roots.
- **Error messages** — changed "project root is too broad" to actionable "call smart_read() on any project file first" when MCP roots unavailable.
- **`isDangerousRoot`** — moved to shared `core/validation.ts` (was duplicated in `index.ts`).

## [0.6.5] - 2026-03-07

### Fixed
- **AST index rebuild race condition** — concurrent tool calls no longer trigger multiple simultaneous rebuilds. `ensureIndex()` now deduplicates via shared promise. If rebuild fails due to lock file (another process running), falls back to existing index if available instead of throwing.
- **Rebuild timeout** — increased from 60s to 120s for large projects where indexing takes longer.

## [0.6.4] - 2026-03-07

### Fixed
- **CRITICAL: Hook installer** — malformed `settings.json` no longer silently destroyed. Distinguishes ENOENT (create fresh) from JSON parse error (abort with message). Uninstall also reports specific errors.
- **CRITICAL: Server startup** — `startServer()` now has `.catch()` handler. Unhandled promise rejections no longer crash the process silently.
- **Non-code handler** — removed `.xml` and `.csv` from `isNonCodeStructured` (no handler existed for them, fell through to null).
- **Symbol resolver** — removed dangerous basename-only fallback in `pathMatches` (`index.ts` no longer matches any `index.ts`). Fixed hardcoded `endLine = start_line + 10` → uses `end_line` from ast-index or 50-line fallback.
- **Config loader** — added prototype pollution guard (`__proto__`, `constructor`, `prototype` keys skipped in deepMerge). Parse errors now logged instead of silently swallowed.
- **File cache** — size tracking now uses `Buffer.byteLength()` instead of `string.length` (chars ≠ bytes for non-ASCII). Removed dead `isSmallFile()` method.
- **Validation** — `optionalNumber` now rejects `NaN` and `Infinity`.
- **Token estimation** — `smart_read_many` now uses `estimateTokens()` instead of `length/4`.
- **Analytics** — `project_overview` calls now tracked in session analytics.
- **read_for_edit** — raised `MAX_EDIT_LINES` from 20 to 60 (20 was too aggressive, truncated most functions).
- **related_files** — raised symbol search limit from 5 to 10 for reverse import detection.

### Removed
- Dead config options `cache.ttlMinutes` and `context.autoForgetMinutes` (declared but never used).

## [0.6.3] - 2026-03-03

### Changed
- **Hook deny threshold** — raised from 200 to 500 lines. Files ≤500 lines pass through Read without denial roundtrip. Eliminates token overhead on medium files where hook denial costs more than outline saves.
- **Adaptive fallback** — lowered from 90% to 70%. If outline ≥70% of raw file size, returns raw content. More aggressive at avoiding outlines that barely save tokens.
- **Tool descriptions** — trimmed marketing language, percentages, and cross-references. ~250 fewer tokens in tool list per session.
- **Outline cap** — top-level symbols capped at 40, class members at 30. Prevents outline explosion on files with 100+ methods.

## [0.6.2] - 2026-03-02

### Removed
- **Dead handler files** — deleted `changed-symbols.ts` (removed in v0.5.0) and `find-callers.ts` (removed in v0.4.0). Were never registered in server but lingered as dead code.

## [0.6.1] - 2026-03-02

### Changed
- **`smallFileThreshold`** — raised from 80 to 200 lines. Benchmark showed medium files (100-300 lines) had negative savings (-25%) because AST outline was larger than the raw file. Files ≤200 lines now pass through as raw content.
- **`smart_read` adaptive fallback** — after generating outline, compares token count vs raw file. If outline ≥ 90% of raw size, returns raw content instead. Eliminates negative savings on any file size, regardless of language or threshold.
- **`session_analytics` honest metrics** — replaced all hardcoded multipliers (`*5`, `*3`) with real full-file token counts from file cache. `tokensWouldBe` now reflects actual file size, not fabricated numbers. Non-file tools (related_files, outline, find_usages) report 1:1 (no savings claim).

## [0.6.0] - 2026-03-02

### Changed
- **Read hook** — upgraded from advisory (`decision: "suggest"`) to blocking (`permissionDecision: "deny"`) for unbounded Read calls on large code files (>200 lines). Bounded Read (with offset/limit) is still allowed. Uses official `hookSpecificOutput` format per Claude Code docs.
- **`read_for_edit` output** — already includes exact `Read(path, offset, limit)` command that passes through the hook, giving AI a clear path: `read_for_edit` → bounded `Read` → `Edit`.

### Added
- **Edit hook** — new PreToolUse hook matching Edit tool. Adds `additionalContext` suggesting `read_for_edit` for minimal code context. Doesn't block Edit — just provides a hint.
- **Hook installer** — now installs and manages both Read and Edit hooks. Uninstall removes all Token Pilot hooks.

## [0.5.3] - 2026-03-02

### Changed
- **`find_unused`** — completely rewritten with universal approach. Removed 60+ hardcoded framework-specific names. Now uses ast-index data: constructors filtered by name (`constructor`/`__init__`), Python dunder methods by `__*__` pattern, decorated symbols detected via `outline()` and shown separately with their decorators. No framework-specific knowledge.
- **`formatFrameworkInfo`** (smart_read display) — removed hardcoded TypeORM (`Column`, `PrimaryGeneratedColumn`) and class-validator (`IsEmail`, `MinLength`) parsing. Now only detects standard HTTP verbs (GET/POST/PUT/DELETE/PATCH) which are protocol-level, not framework-specific. All other decorators shown as-is (`@DecoratorName`).
- **`outline`** — route detection now universal. Instead of hardcoding `@Controller`, detects any class decorator with a path argument as route prefix. HTTP verb detection uses same universal pattern. Non-HTTP decorators shown as-is.

## [0.5.2] - 2026-03-02

### Fixed
- **`project_overview`** — HINT no longer references deleted `search_code()`, now suggests `find_usages()` and `outline()`
- **`related_files` imported_by** — now searches both `imports` AND `usages` from refs (not just imports), with increased limit (30). Cross-language filtering preserves same-family matches while removing false positives.
- **`find_unused`** — excludes framework-implicit symbols (replaced by universal approach in 0.5.3)
- **README** — updated handler file list (removed deleted handlers, added new ones)

## [0.5.1] - 2026-03-02

### Fixed
- **`read_for_edit` symbol mode** — large symbols (>20 lines) now return only the first 20 lines instead of the entire method. Prevents returning 300+ lines when only a signature is needed for editing.
- **`related_files` imported_by** — filter cross-language false positives. A TypeScript file no longer shows Python/Go/Rust files as importers. Refs are filtered by language family (JS/TS, Python, Go, JVM, etc.).
- **`session_analytics`** — honest savings metric for `read_for_edit`. Reduced multiplier from 30x to 3x (realistic comparison vs `Read` with offset/limit, not vs full file).

## [0.5.0] - 2026-03-02

### Added
- **`read_for_edit`** — killer feature for edit workflow. Returns RAW code (no line numbers) around a symbol or line, ready to copy as `old_string` for Edit. 97% fewer tokens than reading full file before editing.
- **`related_files`** — import graph for any file: what it imports, what imports it, test files. Saves 3-5 Read calls per task.
- **`outline`** — compact overview of all code files in a directory. One call instead of 5-6 smart_read calls. Framework-aware: shows HTTP routes for NestJS controllers.
- **`read_symbol` show parameter** — `show: "full"|"head"|"tail"|"outline"` controls truncation. Default: auto (full ≤300 lines, outline >300).
- **Framework-aware decorators** — smart_read/outline parse NestJS (`@Controller`+`@Get` → HTTP routes), TypeORM (`@Column` → types), class-validator (`@IsEmail` → constraints).

### Removed
- **`search_code`** — worse than Grep in practice, find_usages + Grep cover all use cases
- **`export_ast_index`** — never used in real work, infrastructure tool only
- **`context_status`** — debugging tool, not user-facing
- **`forget`** — manual context management = poor design, should be automatic
- **`changed_symbols`** — git diff + smart_read covers this use case

### Changed
- **12 focused tools** instead of 14 — removed 5 low-value, added 3 high-impact
- Edit-heavy sessions: 5-10% → 40-50% token savings (via read_for_edit)
- Average sessions: 20-25% → 45-55% token savings

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
