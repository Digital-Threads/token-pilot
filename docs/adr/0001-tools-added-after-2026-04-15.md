# ADR 0001 — Six MCP tools added after the 2026-03-31 plan

**Status:** Accepted (retroactive)
**Date:** 2026-06 (documenting decisions made 2026-04-15 → 2026-05)
**Supersedes:** nothing
**Context bead:** token-pilot-56i (B13)

## Context

The `2026-03-31-token-savings-improvements` plan registered 13 MCP
tools. By 2026-05 the server (`src/server.ts`) exposed 19. Six tools
were added after the plan was frozen, without their own design notes,
which left a "why does this exist?" gap a few months on. This ADR
captures the reasoning retroactively so the tool surface is
self-documenting.

## Decision

We kept all six. Each fills a concrete gap the original 13 left open.

| Tool | Added | Why it exists | Cheaper than |
|------|-------|---------------|--------------|
| `read_symbols` | post-plan | Batch sibling of `read_symbol` — fetch N function/class bodies from one file in a single call instead of N round-trips. | N× `read_symbol` |
| `read_section` | post-plan | Read one heading / key / row-range from markdown / yaml / json / csv without loading the whole structured file. | full `Read` of a doc |
| `module_info` | post-plan | Module-level architecture view: deps, dependents, public API. Answers "what depends on this module?" without manual import tracing. | many `find_usages` |
| `explore_area` | post-plan | One-call directory dive: outline + imports + tests + git log. Replaced the four-tool dance when starting work in a new area. | 4 separate calls |
| `session_budget` | 2026-04-15 spec | Lets an agent declare/track a per-session token ceiling so long sessions can self-pace before auto-compaction. | nothing — new capability |
| `session_snapshot` | 2026-04-15 spec (`2026-04-15-session-snapshot-design.md`) | Persist goal/decisions/files/next-step to disk so a session survives `/clear` and compaction. The compaction-bridge half of the product. | re-prompting from scratch |

`session_budget` and `session_snapshot` DO have a design spec
(`docs/superpowers/specs/2026-04-15-session-snapshot-design.md`); the
other four were added as natural batch/convenience siblings of
existing tools and never warranted a standalone spec. This ADR is
their record.

## Consequences

- The tool count in marketing copy and `plugin.json` must track the
  real surface (corrected to 25 agents / 19 tools in v0.34.x).
- Every server tool case routes through `SessionCache`, so the four
  convenience tools inherit cross-call dedup for free — no separate
  caching design needed.
- Future tool additions: add a one-row entry to this ADR (or a new
  ADR for anything with non-obvious trade-offs) at the time of the
  change, not months later.

## Alternatives considered

- **Prune the four convenience tools** to keep the surface at the
  planned 13 + 2. Rejected: tool-audit data (2026-04-24) showed
  `explore_area` and `read_section` in real use, and the batch tools
  cut round-trips measurably. Removing them would re-introduce the
  N-call patterns they exist to collapse.
