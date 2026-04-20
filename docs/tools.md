# MCP Tools Reference

Token Pilot exposes 22 MCP tools. All handlers remain active regardless of [tool profile](configuration.md#tool-profiles) — the profile only trims what appears in `tools/list` at session start.

## Reading

| Tool | Instead of | Purpose |
|------|-----------|---------|
| `smart_read` | `Read` | AST outline; 90% fewer tokens on large files |
| `read_symbol` | `Read` + scroll | One class/function by name (`Class.method` supported) |
| `read_symbols` | N × `read_symbol` | Batch up to 10 symbols from one file |
| `read_for_edit` | `Read` before `Edit` | Minimal raw code around a symbol — copy directly as `old_string` |
| `read_range` | `Read` offset | Specific line range |
| `read_section` | `Read` | Section by heading (Markdown) or key (YAML/JSON/CSV) |
| `read_diff` | re-`Read` after edit | Changed hunks since last `smart_read` |
| `smart_read_many` | multiple `Read` | Batch smart_read for up to 20 files |

## Search & Navigation

| Tool | Instead of | Purpose |
|------|-----------|---------|
| `find_usages` | `Grep` (refs) | All usages of a symbol; filters by scope/kind/lang/mode |
| `project_overview` | `ls` + explore | Project type, frameworks, architecture, directory map |
| `related_files` | manual | Import graph: imports, importers, test files |
| `outline` | multiple `smart_read` | Compact symbol overview of all code in a directory |
| `find_unused` | manual | Dead code detection — unreferenced exported symbols |
| `code_audit` | multiple `Grep` | TODOs, deprecated symbols, structural patterns |
| `module_info` | manual | Deps, dependents, public API, unused deps |
| `smart_diff` | raw `git diff` | Structural diff with symbol mapping |
| `explore_area` | 3–5 calls | Structure + imports + tests + recent changes in one call |
| `smart_log` | raw `git log` | Structured commits with category detection |
| `test_summary` | raw test output | Run tests → pass/fail summary + failure details |

## Session

| Tool | Purpose |
|------|---------|
| `session_snapshot` | Compact markdown snapshot (<200 tokens) of goal, decisions, facts, blockers, next step. Auto-persisted to `.token-pilot/snapshots/latest.md`. |
| `session_budget` | Hook-suppression pressure for this session: saved tokens, burn fraction, effective denyThreshold, time-to-compact projection. |
| `session_analytics` | Token savings: per-tool breakdown, top files, policy advisories. |

## `find_usages` modes

`find_usages` accepts a `mode` parameter:

| Mode | Output | Tokens |
|------|--------|--------|
| `full` | Symbol usages with surrounding code context | ~5–20× more |
| `list` *(strict default)* | File:line pairs only — 5–10× smaller | smallest |

In `TOKEN_PILOT_MODE=strict`, `mode` defaults to `"list"` when not set by the caller. Pass `mode: "full"` explicitly to override.

## `smart_read` scopes

| Scope | Output |
|-------|--------|
| *(default)* | Full AST outline with types, signatures, docs |
| `nav` | Names + line numbers only (2–3× smaller) |
| `exports` | Public API surface only |

In `TOKEN_PILOT_MODE=strict`, `max_tokens` defaults to 2 000 when not set by the caller.
