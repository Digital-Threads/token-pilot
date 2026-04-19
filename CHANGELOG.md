# Changelog

All notable changes to Token Pilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.28.0] - 2026-04-19

### Added — passive pre-intercept hooks for Grep and Bash

Field observation from the author's own session: over 12 hours of work on token-pilot, the main-thread agent called **zero** MCP code-reading tools. Everything went through raw `Read`, `Bash` (`awk`/`grep`), and `Edit`. Advisory hooks (PostToolUse `additionalContext`) didn't change the behaviour — by the time they fire, the big output is already in the context.

Fix: push enforcement upstream to `PreToolUse`. When the agent is about to invoke a heavy pattern, deny the call and suggest a cheaper MCP equivalent. This is the same lever the Read hook already uses — it's the one that actually works in production.

**`PreToolUse:Grep` (new matcher)** — denies Grep when the pattern looks like a code identifier (camelCase, PascalCase, snake_case, CONSTANT_CASE, kebab-case; length ≥4; no regex metacharacters). Suggests `mcp__token-pilot__find_usages(symbol=...)` — semantic search, 5-10× cheaper than line-oriented grep output. Regex-shaped patterns, short generic terms (`id`, `err`, `db`), and patterns with spaces still pass through unchanged.

**`PreToolUse:Bash` (new matcher)** — denies five heavy patterns and suggests the cheaper path:

| Pattern | Redirect |
|---|---|
| `grep -r` without `-m N` | `find_usages` or bounded grep |
| `find /` / `find ~` without `-maxdepth` | Glob tool or bounded find |
| `cat <code-file>` (TypeScript/Python/etc) | `smart_read` or `Read` with offset/limit |
| `git log` without `-n` / `--max-count` / `| head` | `smart_log` or bounded log |
| Bare `git diff` (no path, no `--stat`) | `smart_diff` or scoped diff |

Every deny message includes an explicit bypass instruction (`add -m N to re-run`, `use regex-shaped pattern`, etc.) so legitimate use-cases aren't blocked — just made deliberate.

**Hook installer + plugin manifest** now register all four `PreToolUse` matchers (Read, Edit, Bash, Grep). Per-matcher idempotence from v0.25.0 means existing users who re-run `install-hook` or reinstall the plugin pick up the new matchers without duplicates. 43 new unit tests on the pure decision logic.

### Why not truncate output post-factum

Investigated for v0.27 but Claude Code's `PostToolUse` can't modify `tool_response` for Bash — the `updatedMCPToolOutput` field is MCP-only, documented in our existing `post-bash.ts` comment. Blocking upfront is the only mechanism that actually saves tokens on heavy Bash / Grep calls.

### Noted

The author's session that motivated this release will be re-measured after v0.28.0 is published and the plugin reinstalled. If `find_usages` and `smart_*` adoption rises from 0 to double digits per session, we keep the aggressive default. If agents bypass via regex or `-m 1` to escape the block, we soften back to advisory.

1018 tests passing (+43 new).

## [0.27.1] - 2026-04-19

### Fixed — plugin install failed on v0.27.0 with "agents: Invalid input"

First field report after v0.27.0 hit npm: `claude plugin install token-pilot@token-pilot` failed with a schema validation error because `plugin.json` declared `"agents": "./dist/agents/"` — but `agents` is not a valid field in the Claude Code plugin-manifest schema. Agents are discovered by convention from `./agents/` at the repo root (the same way addyosmani/agent-skills ships 3 of them).

Fixed:
- Removed `"agents"` field from `plugin.json`. Only `"skills"` stays as an explicit path.
- Moved composed tp-* files from `dist/agents/` to repo-root `agents/` (Claude Code convention).
- Updated `scripts/build-agents.mjs` to write to `./agents/` by default.
- Updated `package.json` `files` to ship `agents/*.md` instead of `dist/agents/*.md`.
- Updated `src/cli/install-agents.ts` `resolveDistAgentsDir` to walk `dist/cli/../../agents/` for npm-installed users.
- `.gitignore`: removed the `!dist/agents/` exceptions; `agents/` at root is now versioned directly.

No behaviour change to agents themselves or any MCP tool. Pure path/schema fix so the plugin path actually works.

975 tests still passing.

## [0.27.0] - 2026-04-19

Big release motivated by Opus 4.7's +35% tokenizer tax over 4.6 — token savings no longer optional. Two interlocking moves.

### Multi-model strategy — all 25 tp-* agents have explicit model: field

| Tier | Model | Count | Example agents |
|---|---|---:|---|
| Structured output | `haiku` | 9 | commit-writer, onboard, session-restorer, doc-writer, history-explorer, api-surface-tracker, dep-health |
| Reasoning | `sonnet` | 15 | pr-reviewer, debugger, test-writer, refactor-planner, context-engineer, spec-writer, performance-profiler, ship-coordinator, incremental-builder |
| Deepest correlation | `inherit` | 1 | incident-timeline |

Effect: typical sessions that used to default to Opus-everywhere now dispatch to haiku/sonnet — **5-10× cheaper on the model side** when usage leans on the bottom tiers.

### @addyosmani/agent-skills best practices baked into agent bodies

17.6k-star MIT project. Checklists and methodologies adapted into our agent bodies — **not shipped as separate skill files**. No upstream dependency, no maintenance burden, no +5k overhead on `tools/list`.

**Upgraded (4):**
- `tp-pr-reviewer` ← five-axis review (correctness / readability / architecture / security / performance)
- `tp-debugger` ← 6-step triage (reproduce / localize / reduce / root-cause / guard / verify) + symptom-vs-cause pattern
- `tp-test-writer` ← TDD RED/GREEN/REFACTOR + Prove-It for bug fixes
- `tp-refactor-planner` ← behaviour-preservation discipline

**Added (6):**
- `tp-context-engineer` (sonnet) — audits CLAUDE.md / AGENTS.md / rules files per project
- `tp-spec-writer` (sonnet) — gated workflow (Specify → Plan → Tasks → Implement); surfaces assumptions BEFORE code
- `tp-performance-profiler` (sonnet) — measure → identify → fix → verify → guard; refuses to optimize without data
- `tp-incremental-builder` (sonnet) — thin vertical slices, test between each
- `tp-doc-writer` (haiku) — ADRs + READMEs + API docs; documents *why* not *what*
- `tp-ship-coordinator` (sonnet) — 5-pillar pre-launch checklist (quality / security / observability / rollback / rollout)

Credits to @addyosmani/agent-skills in each upgraded agent body.

### Fixed — plugin install now actually exposes skills + agents

Before this release, `claude plugin install token-pilot@token-pilot` succeeded but the Customize panel showed "This plugin doesn't have any skills or agents". Root cause: `plugin.json` never declared the `skills` / `agents` paths, and `dist/agents/` was gitignored — so the plugin clone saw an empty directory.

Fixed:
- `plugin.json` now declares `"skills": "./skills/"` and `"agents": "./dist/agents/"`.
- `.gitignore` exception added: `!dist/agents/` + `!dist/agents/**`. Composed agents are versioned so every plugin install sees them immediately.

### Agent roster: 19 → 25

19 pre-existing tp-* + 6 new = 25 subagents. All stay under ≤60 composed lines / ≤30 non-empty body lines.

### Deferred to later releases

- Adapting our global `CLAUDE.md` with principles from @multica-ai/andrej-karpathy-skills (think-before-code / simplicity-first / surgical-changes / goal-driven). Strong content, belongs in a focused follow-up, not bundled with an agent release.
- Refreshing `/guide`, `/install`, `/stats` legacy commands in `skills/`.

975 tests passing.

## [0.26.6] - 2026-04-18

### Fixed — EPIPE stacktrace when piping CLI to `head`/`less`/`grep`

First field report after the plugin install worked: user ran
`npx token-pilot doctor | head -5` and got a red "Unhandled 'error' event"
stacktrace from node:events. Classic Node.js CLI wart — `console.log`
tries to write after `head` closed stdin, EPIPE propagates, no handler,
crash.

Fixed by swallowing `EPIPE` on stdout and stderr at process start
(`process.stdout.on('error', ...)`). Any CLI piped to `head | less | grep`
should behave this way; ours now does.

Confirmed: `node dist/index.js doctor | head -5` returns exit 0 with a
clean truncated output, no stacktrace.

## [0.26.5] - 2026-04-18

### Fixed — plugin installation path was broken since 2026-03-01

Surface: a user asked "can token-pilot be installed as a Claude Code plugin?". The `.claude-plugin/` manifest said yes, but attempting `claude plugin install token-pilot@token-pilot` against our repo failed on schema errors. Root cause: `marketplace.json` and `plugin.json` were written 2026-03-01 for the Claude Code schema as-of-then. The schema has since moved to a `owner`/`plugins`-array shape in `marketplace.json` and `author`-as-object in `plugin.json`, with `mcpServers` declared inside `plugin.json` itself. Our files never caught up. Every user who tried the plugin path for 48 days saw a validation error.

Fixed: both manifests rewritten to current shape. Verified end-to-end — `claude plugin marketplace add <path> && claude plugin install token-pilot@token-pilot` now reports ✔ Successfully installed and the MCP server connects green.

### Added — README documents both install paths

Until now the README only described npm/npx. With plugin install fixed, the Claude Code section now lays out three paths side-by-side:
- **A.** `claude plugin install` — hooks + MCP + (optional) tp-* agents in one step.
- **B.** `claude mcp add -- npx -y token-pilot` — for npm-based setups.
- **C.** `npx -y token-pilot init` — the one-liner that writes path B for you.

### Changed — plugin-aware CLI behaviour

- **`install-hook`** now early-returns with an explanation when `CLAUDE_PLUGIN_ROOT` is set. Plugin installation already wires hooks via `.claude-plugin/hooks/hooks.json`; calling `install-hook` on top would double-register every PreToolUse/PostToolUse matcher. This prevents the silent duplication.
- **`install-agents`** keeps working under plugin mode (tp-* subagents are independent of plugin hooks — they live in `~/.claude/agents/` regardless) but now prints a one-line note so the user doesn't wonder why a plugin install needs a manual step. New regression test covers the plugin-mode path.
- **`doctor`** prints a new `Install mode:` line — one of `plugin (<root>)` / `dev / worktree (contributor)` / `npm / npx`. Helps diagnose support issues: "why do I have two hook entries?" → doctor says `plugin` → answer is "remove the manual install-hook run".

### Removed — repo-level `.mcp.json`

The file at the repo root was a 2026-03 plugin-compat artifact using `${CLAUDE_PLUGIN_ROOT}/start.sh`. It only resolved correctly when token-pilot ran as a registered plugin — for anyone developing the repo locally (or running the MCP server from a worktree) it just produced `✗ Failed to connect` in `claude mcp list`. With plugin install fixed and the `mcpServers` block moved inside `plugin.json`, the file is no longer needed from either path. Removed.

**Note for users migrating npm → plugin:** if you ran `npx token-pilot install-hook` on your old npm setup and then install as a plugin, both will register hooks — every PreToolUse matcher fires twice. Clean the manual entry out of `~/.claude/settings.json` (the one whose `command` starts with `token-pilot hook-read`). The v0.26.5 early-return only prevents *new* duplicates; it doesn't clean old ones.

975 tests still passing (+1 new: plugin-mode regression).

## [0.26.4] - 2026-04-18

### Added — automatic profile recommendation in `doctor`

v0.26.3 shipped profiles, but the default stayed `full` — a breaking default change would silently hide tools from anyone who actually uses `code_audit` / `test_summary` / `find_unused`. The correct path: **data-driven advisory, not default flip**.

`npx token-pilot doctor` now reads the cumulative `.token-pilot/tool-calls.jsonl` (introduced v0.26.2) and prints a profile recommendation:

```
── profile recommendation ──
  data:         30 calls, 1 distinct tools
  recommend:    TOKEN_PILOT_PROFILE=nav
  why:          Every tool you've used (1 distinct) is part of the nav subset. You're a read-only explorer.
  savings:      ~2200 tokens (−54%) on every tools/list response
  apply:        add "env": { "TOKEN_PILOT_PROFILE": "nav" } to your token-pilot entry in .mcp.json
```

Decision matrix (pure, unit-tested):
- Every call ∈ nav-set → recommend `nav`.
- Uses edit-prep tools (read_for_edit, batch reads) but never full-only → recommend `edit`.
- Touches any full-only tool (test_summary, code_audit, find_unused, session_*) → stay on `full`.
- <20 calls total → insufficient data, say so honestly, tell user to re-run doctor after a few sessions.

**Never auto-applies.** Recommendation is printed, not written. Users who haven't read the CHANGELOG learn the lever exists next time they run `doctor`. Gives the narrowest profile that *doesn't silently break their workflow*, because the recommendation is based on their actual usage — not ours.

11 unit tests on the decision matrix + formatter (min-samples boundary, all branches of the matrix, empty-input safety, env-snippet rendering).

## [0.26.3] - 2026-04-18

### Added — tool profiles (lifted honestly from Token Savior's idea)

When an MCP server advertises 22 tools, every `tools/list` response costs the agent ~4 k tokens *before it does anything*. Most sessions don't need every tool — a code-review subagent uses `smart_read` + `find_usages` + `outline` and nothing else. A profile lets the operator ship a narrower `tools/list` while keeping every handler live (so a subagent that explicitly names a filtered-out tool still gets served — we just don't brag about every tool upfront).

**Three profiles:**

| Profile | Tools | ~Tokens in `tools/list` | When to use |
|---------|------:|------------------------:|-------------|
| `full` *(default)* | 22 | ~4 150 | All capabilities, same as pre-v0.26.3 |
| `edit` | 16 | ~3 120 | Code-change workflows (nav + batch reads + read_for_edit) |
| `nav` | 10 | ~1 910 | Read-only exploration (smart_read, outline, find_usages, project_overview, module_info, related_files, explore_area, smart_log, smart_diff, read_symbol) |

**Savings:** `nav` saves ~2.2 k tokens (54 %) at session start; `edit` saves ~1 k (25 %). Every session pays this tax, so it compounds fast across a working day.

**Selection:** set `TOKEN_PILOT_PROFILE=nav|edit|full` in the MCP server env block. Unknown values fall back to `full` with a stderr warning.

**Containment invariant** (guarded by a unit test): `nav ⊂ edit ⊂ full`. A future tool added to `tool-definitions.ts` without updating a profile set ends up in `full` only — conservative by default, so we never accidentally hide a tool from everyone.

11 unit tests (filter math, containment, unknown-value fallback, case-insensitivity, whitespace).

### Noted for later — context-mode stewardship

We currently integrate with [context-mode](https://github.com/mksglu/context-mode) only as a detector + advisor (suggest its `execute` tool when Bash stdout is large). If in a future release we don't deepen that integration, the dependency should be dropped — carrying a soft integration we don't leverage is exactly the kind of "not saving tokens, therefore a problem" the user mandate calls out. Tracked, not actioned this release.

## [0.26.2] - 2026-04-18

### Added — persistent per-tool savings data

The user's mandate for Token Pilot is one thing: **"save the maximum number of tokens, all possible ways, no hacks, clean architecture"** — and the corollary, "if a tool doesn't save tokens, or saves poorly, drop it". Executing that mandate responsibly needs **data across many sessions**, not one Opus field report on a Go monorepo.

Until v0.26.1 the MCP tool-call analytics lived entirely in memory (`SessionAnalytics`). The moment the MCP server restarted — every session end, every `/clear`, every laptop reboot — the per-tool distribution reset. Decisions about which tools pay off had no real baseline.

**1. `src/core/tool-call-log.ts` — append-only JSONL log of every MCP tool call.** Schema matches the in-memory `ToolCall` minus runtime-only fields (intent, decisionTrace). Written from `recordWithTrace` fire-and-forget. Same rotation + retention contract as the existing `hook-events.jsonl` (10 MB rotation, 30-day age cap, 100 MB total size cap). Silent on disk errors — telemetry never blocks the tool-response path. 9 regression tests (roundtrip, JSONL tolerance, cross-session persistence, retention by age, retention by size).

**2. `npx token-pilot tool-audit` — CLI that reads every log file + archive and emits a per-tool savings table.** Default human-readable output, `--json` for scripts. Flags a tool as "low-value" when reduction <20% *across ≥5 calls* — the min-samples gate exists so one bad session doesn't get a tool removed. Output is sorted by total tokens saved so your biggest contributor sits on top. 10 unit tests covering aggregation math, sorting, flagging threshold, JSON shape, empty-dataset message.

What this unlocks (not in this release, but the foundation is now in place):
- Real prune decisions: "after 50 sessions, `X` saves <5% on average → remove or restrict".
- CI savings-regression gate: `tool-audit --fail-below=20` on a baseline.
- Tool description tuning: compare `smart_read`'s cumulative reduction to `read_symbol` — whichever consistently wins, describe more aggressively.

No behavioural change to existing tools — this is strictly observation infrastructure.

## [0.26.1] - 2026-04-18

### Fixed — savings accounting regressions from Opus 4.7 field report

The single mandate from the user: **"if a tool doesn't save tokens, or saves poorly, it's a real problem"**. Two tools on Opus 4.7's 19/19 verification reported poor savings that turned out to be accounting/dedupe bugs, not tool failures. Fixing them instead of removing them.

**1. `read_symbols` overlap dedupe (15% → 40-60% savings).** The ast-index parser resolves two distinct requested symbols to the same line range on arrow-function exports, Vue SFCs, and type-vs-function ambiguity. Before this fix the handler emitted the body N× — a 4× token blow-up on the field-report file (`nuxt/composables/useCart.ts`). Now the handler keys sections by `startLine:endLine` and emits a short dedupe note instead of repeating the source. Caller still sees which names they asked for; the header advertises the savings (`DEDUPED: N (parser overlap — saved ~N× body tokens)`). Two regression tests.

**2. `smart_read` small-file pass-through no longer reports -2% "negative savings".** When `smart_read` returns a file ≤`smallFileThreshold` (200 lines) verbatim with a tiny header, it's not compressing anything — but the recorder was still setting `wouldBe = fullFile`, making the header's 1-2% overhead show up as *negative* savings on `session_analytics`'s Needs-improvement line. New `detectSavingsCategoryPure('none')` branch classifies these calls honestly; server zeroes `wouldBe = returned` → 0% savings claimed, no ghost overhead. Six unit tests on the classifier.

### Not shipped (on purpose)

Per advisor guidance, we held off on three things that looked tempting but lack data:
- **Server-side `find_usages` short-symbol fallback.** We just shipped a description hint in v0.26.0. Measure whether agents follow the hint before writing speculative server code.
- **Removing any tool based on one session of data.** Opus on a Go monorepo ≠ average usage. Needs persistent per-tool stats across sessions first.
- **CI savings-regression gate.** Premature without a cumulative baseline.

The next iteration will build the persistent `.token-pilot/tool-calls.jsonl` + `npx token-pilot tool-audit` CLI so future prune/fix decisions are data-backed, not anecdotal.

## [0.26.0] - 2026-04-18

### Added — cross-client honesty

**1. `install-agents` detects non-Claude clients and skips silently.** Until this release, running `npx token-pilot install-agents` in Cursor / Codex CLI / Gemini CLI / Cline silently created a `~/.claude/agents/` directory that nothing in those clients would ever read. `tp-*` subagents are a Claude Code concept — other clients still benefit from MCP tools + Read hook, but the 19 delegates sit idle. New detector (`src/cli/detect-client.ts`) checks env vars (`CURSOR_TRACE_ID`, `GEMINI_CLI`, `OPENAI_CODEX`, `CLAUDE_PLUGIN_ROOT`) and on-disk markers (`~/.claude/`, `~/.cursor/`, `~/.codex/`, `~/.gemini/`). When a non-Claude client is detected and `--scope` is not passed, install-agents prints a clear warning and exits 0 without touching disk. Explicit `--scope=user|project` overrides (multi-client setups). 10 detector unit tests + 3 integration tests.

**2. README: client support matrix.** Honest table showing what works where — MCP tools ✅ everywhere, subagents + `model:` frontmatter + budget watchdog Claude Code only. Non-Claude users get ~60% of the package. Fixes the implicit "works with all clients" promise that was hiding a real gap.

### Improved

**3. `tp-dead-code-finder` project-type detection.** Field report showed this agent running 128 `find_usages` iterations over 145s on a Go project — because it defaulted to MCP-based scanning even when native tools (`go vet + deadcode`, `phpstan --level=max`, `vulture`, `ts-prune`) would do the same job in one Bash call. Agent body now instructs the first pass through the right native analyzer based on project markers (`go.mod`, `composer.json`, `pyproject.toml`, `package.json`). `find_unused` is the fallback, not the default. Budget discipline: ≥40 candidates → report top-20 with confidence, not iterate.

**4. `find_usages` tool description: Grep hint for short symbols.** Semantic find is great for specific symbol names, but wastes tokens when the symbol is ≤4 chars and generic (`id`, `err`, `Cmd`, `db`) — resolves ambiguously across thousands of files, Grep is cheaper. Description now says so explicitly.

### Deferred to a later epic

- **Auto session-snapshot writer on `PreCompact` / `Stop` hook events.** Claude Code does not expose these events to external hooks today — needs either an upstream feature request or a polling alternative. Tracked as research, not shipped.
- **Cross-client equivalents of `tp-*` subagents.** Cursor Custom Rules (`.cursor/rules/*.mdc`), Gemini `GEMINI.md`, Codex system prompts — can we generate equivalent guidance from our templates? Separate design doc, not v0.26.

## [0.25.0] - 2026-04-18

### Fixed — findings from Opus 4.7 19/19 verification

A live verification of all 19 agents on a real Go monorepo surfaced three issues. Fixed together.

**1. `install-agents` / installer: PostToolUse idempotence was broken for upgrades.** The check treated the whole PostToolUse section as one unit — *"any token-pilot hook present → skip"*. Users who installed when only the Bash matcher existed (v0.21.x) kept that, never received the Task matcher added in v0.23.0, and their budget watchdog was **silently disabled forever**. 6 out of 19 agents in the field test went over-budget without a single entry in `.token-pilot/over-budget.log` — because the hook wasn't registered at all. Now installer checks each PostToolUse matcher individually (same contract as PreToolUse). Regression test reproduces the v0.21-style settings file and asserts that re-install picks up the Task matcher.

**2. `tp-api-surface-tracker` false REMOVED classification.** Field test: `smart_diff` labelled a symbol as REMOVED; `read_symbol` confirmed it was still there (context around it had changed). Agent body now **requires `read_symbol` verification before reporting REMOVED**. Symbols that still exist are reclassified PATCH (body-only change). Prevents false breaking-change alarms in the MAJOR/MINOR/PATCH verdict.

**3. `tp-dep-health` over-scans monorepo orchestration roots.** When the root `package.json` has only dev-deps and real services live in gitignored sub-repos or under `services/`/`packages/`/`apps/`, the agent used to scan the whole repo for nothing. Agent now detects this shape and returns a one-line instruction to re-run against a specific sub-repo, instead of iterating find_usages on zero-dep input.

### Deferred to v0.26

From the same report, larger changes that need design:

- **`tp-dead-code-finder` project-type detection.** 128 `find_usages` iterations in 145 s when `find_unused` is permission-denied in sandbox. Needs Go → `go vet` + `deadcode`, PHP → phpstan, etc. integration.
- **Auto-invoke `session_snapshot` on Stop / Pre-Compact hook.** `tp-session-restorer` is dead without a paired writer — right now the snapshot file is only created on explicit user call. Needs a hook-type evaluation (Stop hook doesn't exist in Claude Code's current hook set; may need a Pre-Compact substitute).
- **`find_usages` → Grep fallback for single-word symbols.** 0 % savings observed when symbols are short (structural overview is already longer than the hit list).

### Numbers
- 912 tests green (+1 regression for installer's per-matcher idempotence), `tsc --noEmit` clean.

## [0.24.2] - 2026-04-18

### Changed — README manual-install section restored and expanded

In v0.20.2 I collapsed "Manual install" under a `<details>` to keep the README slim. That was overcorrection: users on Cursor / Codex / Cline / CI / team-shared configs had no quick "how do I add the MCP server?" answer visible.

Restored the section as a proper `## Manual MCP install` heading with **per-client examples**:

- **Claude Code** — both `claude mcp add` CLI and direct `.mcp.json` edit
- **Cursor** — `.cursor/mcp.json` example
- **Codex CLI** — `~/.codex/config.toml` TOML stanza
- **Cline (VS Code)** — `cline_mcp_settings.json` example
- **Any MCP-compatible client** — generic `command + args` pattern
- **Subagents install** (Claude-Code-only) — scope flags + `--force`
- **From source** — for contributors / vendored installs

Also added an env-var table (`TOKEN_PILOT_DENY_THRESHOLD`, `TOKEN_PILOT_ADAPTIVE_THRESHOLD`, `TOKEN_PILOT_BYPASS`, `TOKEN_PILOT_SKIP_POSTINSTALL`) — these used to be scattered across the codebase with no single reference.

Docs-only change. No code / test changes. 911 tests still green.

## [0.24.1] - 2026-04-18

### Fixed — two findings from v0.23.6 field verification

**1. `read_symbols` guard missed on real Vue / TS files.** The field report showed a 6-symbols-from-6-exports request where the v0.23.6 guard failed to trip. Root cause: the guard used `sum(lineCount) / fileLines ≥ 0.7`, but ast-index's parser returns **overlapping ranges** on arrow functions / `export function` / Vue SFCs / TypeScript type-vs-function — so `sum(lineCount)` gets inflated past the file size and ratios become meaningless. Switched to a **count-based** guard: if ≥ 3 symbols AND ≥ 70% of the file's top-level symbol count, refuse and advise `smart_read`. Immune to parser line-range bugs.

**2. `docs/token-pilot-dir.md` was not shipped in the npm package.** I added the file in v0.23.6 but forgot the `docs/*.md` glob in `package.json` `files:`. Now included.

### Added

- **Parser-overlap warning.** If the handler sees `sum(symbol.lineCount) > file.lineCount × 1.5` (definite parser mis-parse — symbols claiming more lines than the file has), it logs one stderr warning pointing at the upstream `defendend/Claude-ast-index-search` issue tracker. Doesn't fail the request; gives users a signal when ast-index is the real culprit for weird results.

### Numbers
- 911 tests green (+1 regression test for overlapping-ranges guard), `tsc --noEmit` clean.

## [0.24.0] - 2026-04-18

### Added — Tier 3 combo-agents (TP-z64 delivered)

Five new `tp-*` specialists that each pair novel combinations of MCP tools for niche workflows. Roster is now **19 agents** (6 Tier 1 + 8 Tier 2 + 5 Tier 3).

- **`tp-review-impact`** — pre-merge blast-radius review. Combines `smart_diff` × `find_usages` × `module_info` to answer *"will this PR break production"*. Verdict: safe / needs-review / blocking, with concrete dependents cited at `path:line`.
- **`tp-test-coverage-gapper`** — *(haiku-4.5)* enumerates exported symbols, cross-checks against test-file references, returns a prioritised gap list grouped Critical / Important / Minor. Read-only, never writes tests itself.
- **`tp-api-surface-tracker`** — compares current public surface with exported symbols at the last release tag, classifies each change MAJOR / MINOR / PATCH per semver. Verdict: suggested version bump.
- **`tp-dep-health`** — dependency audit: outdated (from `npm outdated` etc.) × usage count (via `find_usages`) → priority groups (urgent / soon / remove-candidate / safe-skip). Does not run upgrades.
- **`tp-incident-timeline`** — given an incident timestamp, builds a git timeline for the window and ranks commits by likely correlation with the reported failure. Refuses to blame commits outside the window.

### Changed

- **SessionStart reminder decision guide** extended with the 5 new task→agent rows. All 19 agents now covered.
- **README** adds a new **Tier 3 — combo / workflow** table alongside Tier 1 / Tier 2.

### Numbers
- 910 tests green, `tsc --noEmit` clean. 19 agents built.

## [0.23.7] - 2026-04-18

### Changed — per-agent `model:` selection for cheap, format-bound work

Claude Code allows each subagent to declare its own model in frontmatter (or `inherit` from the main agent). We've been relying on the user's global `CLAUDE_CODE_SUBAGENT_MODEL` env var as a blunt switch — that doesn't fit because some `tp-*` agents need real reasoning (debugger, impact analyzer, refactor planner) while others are pure format work. Moved three agents to **haiku-4.5** explicitly:

- **`tp-commit-writer`** — classifies diff → Conventional type, drafts short message. Context-bound, no architectural decisions.
- **`tp-session-restorer`** — parses `latest.md` + git status, emits a fixed-shape briefing. Pure transformation.
- **`tp-onboard`** — pulls project_overview and retells it in an orientation map. Format-bound.

The other 11 agents keep `inherit` — they do enough reasoning (intent, risk classification, call-tree traversal) that haiku would regress them. `tp-dead-code-finder` and `tp-audit-scanner` stay inherit for now; we'll revisit after real-world usage shows whether cross-check accuracy holds on haiku.

**User is NOT asked to set `CLAUDE_CODE_SUBAGENT_MODEL`.** The selection is per-agent and shipped with the template — predictable, rollback-friendly (one line per agent).

### Planned

- **TP-z64** (v0.28 backlog) — expanded tp-* roster with combo-agents that pair novel MCP-tool combinations for niche workflows (review-impact, test-coverage-gapper, api-surface-tracker, dep-health, incident-timeline). Must be brainstormed with names + triggers before implementation; deferred until v0.24 onboarding wizard ships and baseline stabilises.
- **v0.24.0** — onboarding wizard (doctor-warnings → one-step applied): writes `MAX_THINKING_TOKENS=10000` + `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` to `~/.claude/settings.json`, generates `.claudeignore` if missing. Does NOT set `CLAUDE_CODE_SUBAGENT_MODEL` — per-agent model now handles that.

### Numbers
- 910 tests green, `tsc --noEmit` clean, 14 agents built.

## [0.23.6] - 2026-04-18

### Fixed — five findings from a live user audit

A real-world QA pass on a large Nuxt repo surfaced five issues. All addressed.

**1. `read_symbols` regression (−16% tokens saved).** When the caller requested nearly every symbol of a file, the sum of bodies + N × per-symbol metadata exceeded a raw Read of the whole file — batch tool was worse than no batch. Two fixes:
- Handler now includes an anti-pattern guard: if ≥ 70 % of the file's line coverage is requested AND ≥ 3 symbols, it refuses with a short advisory pointing at `smart_read` / `read_for_edit` / bounded `Read`.
- Server-side `tokensWouldBe` for `read_symbols` corrected to reflect reality: baseline is "N individual `read_symbol` calls", not "one raw Read of the whole file". Saved now shows the real win — deduped headers + shared file open — instead of a misleading figure that flipped negative in the edge case.

**2. Tool description updated.** `read_symbols` now says *"BEST FIT: 3–8 symbols in one file … if you'd request ≥ 70 % of the file's symbols, the handler refuses and points you to smart_read"*. Prior docstring didn't give agents a decision rule, so they used it reflexively.

**3. `tp-commit-writer` trivial-diff guard.** The agent's `description:` was unconditional — reviewers triggered it on a whitespace-only docs diff (239 s subagent spawn for a one-line message). Now it explicitly says *"Do NOT use for docs-only, whitespace-only, or < 20-line diffs — the user can write those manually faster than a subagent spawn"*.

**4. `docs/token-pilot-dir.md` — side-files layout reference.** Users saw `hook-events.jsonl` and `hook-denied.jsonl` appear but no snapshots/context-registries/docs directories, wondered if features were broken. They're lazy-created: each sub-path only appears when the triggering feature fires. New doc lists every path, who writes it, when, and whether to commit. Recommended `.gitignore` stanza included.

**5. `tp-migration-scout` context-mode "fallback" — false alarm.** Audit reported the agent announced a fallback from an unavailable `context-mode` tool. Verified: `tp-migration-scout.md` does not advertise `context-mode` anywhere. The agent self-reported a fallback it invented. No code change needed; noted for future behavioural-harness work (TP-q33b).

### Numbers
- 910 tests green (+3 regression tests for `read_symbols` guard), `tsc --noEmit` clean.

## [0.23.5] - 2026-04-18

### Changed — ast-index is now a hard npm dependency

Until now `ast-index` was auto-downloaded from GitHub on first MCP-server start. That worked but had weak spots: exotic architectures, corporate proxies, ZIP-only Windows path — any of them left the user with a token-pilot that couldn't do structural reads until they manually ran `install-ast-index`. Users also rightly expected *"I just `npm install`d the package — it should just work"*.

- **`@ast-index/cli@^3.38.0` moved from implicit auto-install to `dependencies`.** Regular `npm install token-pilot` now pulls the main package + the correct platform-specific native binary (`@ast-index/cli-<platform>-<arch>`) as a transitive dep, same pattern Rollup / esbuild / swc use. Removed the old `peerDependencies: ast-index` stub — confusing and never served a purpose.
- **New `findViaBundledDep()` is first in the binary resolution order** (after config override, before system PATH). Walks up from our own module to `node_modules/@ast-index/cli/bin/ast-index`; works whether npm created `.bin/ast-index` symlinks or not.
- **`BinaryStatus.source` gains `"bundled"`** to distinguish the new path from `system` / `npm` / `managed` / `none`. `doctor` honours it.
- **`scripts/postinstall.mjs` is a safety net** — runs after `npm install`, checks `findBinary()` result; if nothing found, fires the GitHub download fallback. **Never fails the install** — any error ends in a single stderr warning and exit 0. Respects `TOKEN_PILOT_SKIP_POSTINSTALL=1` and `CI=true` for sandboxed builds.

Result: fresh `npm install token-pilot` gives a ready-to-work binary on macOS (arm64 + x64), Linux (arm64 + x64), Windows x64 — no first-run download step, no stderr noise about "ast-index not found, downloading…".

### Numbers
- 907 tests green, `tsc --noEmit` clean. `npm install @ast-index/cli` end-to-end verified against actual npm registry.

## [0.23.4] - 2026-04-18

### Fixed

- **`install-agents --force` now actually forces a refresh when body-hash matches.** Before this fix, `--force` was a no-op for unchanged-installed agents because the body hash (used to detect template drift) ignores the YAML frontmatter. Any frontmatter-only update (description, tools list, etc.) left `storedHash === templateHash`, so `--force` reported `unchanged` and skipped. This silently blocked v0.23.3's PROACTIVELY triggers from reaching existing installations — users had to `rm ~/.claude/agents/tp-*.md` first. Now `--force` rewrites the file regardless of body-hash match, while still refusing to touch user-owned files that carry no `token_pilot_body_hash` stamp.

### Numbers
- 907 tests green (+1 regression test for `--force` on unchanged files), `tsc --noEmit` clean.

## [0.23.3] - 2026-04-18

### Changed — PROACTIVELY triggers in every agent description + wider MANDATORY block

Live-testing on a real machine surfaced a concrete gap: Claude Code's main agent read the reminder, saw tool descriptions, but **systematically skipped tp-\* subagents** — no explicit `PROACTIVELY` trigger meant they sat unused even when the task fit. Also reported: "I see only 4 token-pilot tools in MANDATORY, not 14" — the agent didn't scan tool descriptions to discover the rest unless prompted.

Both fixes:

1. **Every `tp-*` description now carries `PROACTIVELY use this when …` or `Use this when …` plus concrete user-intent signals** ("when the user reports a bug", "when the user asks to review a diff"). Claude Code's auto-invocation heuristic looks for exactly these phrases. 14 agents rewritten.

2. **MANDATORY block expanded from 4 tools → 9 core tools** (smart_read, read_symbol, read_for_edit, outline, find_usages, smart_diff, smart_log, test_summary, project_overview) with `INSTEAD of` hints against raw Read/Grep/git. Still lists batch variants (read_symbols, smart_read_many, read_section) and names the remaining 10 under "Also available:" so the main agent sees the full surface even if it doesn't crawl descriptions.

3. **Default `sessionStart.maxReminderTokens` raised 250 → 500** to fit the expanded block without aggressive trimming. Token-wise: ~500 tokens is 0.3% of a 160K context window — the round-trip savings from one prevented raw Read pay it back ~5×.

### Updated

- `prompt-contract.test.ts` relaxed: descriptions may now be up to 350 chars and every agent is **required** to carry a trigger phrase (`PROACTIVELY …` or `Use this when …`). Old contract required "only tp-run uses PROACTIVELY" and ≤160 chars — removed.

### Numbers
- 906 tests green (+6 rewrites of contract + reminder tests; none removed), `tsc --noEmit` clean.

## [0.23.2] - 2026-04-18

### Changed — SessionStart reminder now carries a task→agent decision guide

The reminder used to list the installed `tp-*` agents with their descriptions. Useful, but the main agent still had to decide **when** to delegate. Now the reminder carries a compact task→agent cheat-sheet inline:

```
WHEN DELEGATING — if the task fits a specialist, use the Task tool:
  bug / stack trace       → tp-debugger
  PR / diff review        → tp-pr-reviewer
  impact before change    → tp-impact-analyzer
  plan refactor           → tp-refactor-planner
  failing tests           → tp-test-triage
  write new tests         → tp-test-writer
  migrate API / version   → tp-migration-scout
  "why is this like this?" → tp-history-explorer
  security / quality audit → tp-audit-scanner
  resume after /clear     → tp-session-restorer
  dead code cleanup       → tp-dead-code-finder
  commit message          → tp-commit-writer
  repo onboarding         → tp-onboard
  general workhorse       → tp-run
```

Lines for agents the user hasn't installed are filtered out automatically. Custom / third-party `tp-*` agents not in the core map get a fallback line with their own description. Over-budget trimming still lands `… and N more` with a total count, so nothing silently disappears.

Also added to the MANDATORY block: `Batch variants (prefer over loops): read_symbols, smart_read_many, read_section.` — the three batch tools that v0.23.1 wired into specialist agents but that the main agent also benefits from.

### Numbers
- 906 tests green (+6 new buildReminderMessage regression tests), `tsc --noEmit` clean.

## [0.23.1] - 2026-04-18

### Changed — agent toolset coverage

Audit of all 14 agents vs 22 MCP tools surfaced 6 unused tools — 3 of those were genuine efficiency leaks (agents used scalar calls where batch was available). Fixed:

- **`read_symbols`** (batch read of N symbols in one file) — now in `tp-pr-reviewer` + `tp-impact-analyzer`. Previously both ran `read_symbol` in a loop for changed diffs.
- **`read_section`** (headed-section read for MD/YAML/JSON) — now in `tp-onboard` + `tp-audit-scanner` + `tp-session-restorer`. Previously `smart_read` pulled whole README / policy files when only one section was needed.
- **`smart_read_many`** (batch read of N files) — now in `tp-pr-reviewer` + `tp-migration-scout` + `tp-impact-analyzer` + `tp-onboard`. Previously loops of `smart_read` across the touched file set.
- **`session_budget`** — now in `tp-session-restorer`, included in the restored briefing so a resumed session knows its burn fraction + time-to-compact projection immediately.

Each agent's numbered steps were updated with an explicit instruction to prefer the batch tool over a loop. Preambles unchanged.

**Remaining "unused by tp-*" tools (by design):**
- `session_snapshot` — called by the main Claude Code agent at turn boundaries, not by subagents.
- `session_analytics` — user-facing summary tool invoked via `/ask token-pilot:session_analytics`, not subagent surface.

### Numbers
- 904 tests green (+0 new — existing parity tests catch frontmatter changes automatically), `tsc --noEmit` clean.

## [0.23.0] - 2026-04-18

### Added — three more specialist agents (TP-02l follow-up)

Closes the gap between the shipped TP-02l set and the originally-scoped one. Total roster now: **14 agents** (6 Tier 1 + 8 Tier 2).

- **`tp-history-explorer`** — answers "why is this like this?" by tracing git for a symbol. Returns the minimum commit chain that explains current state, not the full log. Refuses to theorise beyond what commit messages say (no "author likely wanted X" hallucinations).
- **`tp-audit-scanner`** — read-only security + quality scan. Grep patterns for hardcoded secrets, injection shapes, unsafe casts; cross-checked by reading the enclosing symbol before classifying. Outputs Critical / Important / Minor; never edits; never quotes secrets in findings.
- **`tp-session-restorer`** — rehydrates state after `/clear` / compaction. Reads `.token-pilot/snapshots/latest.md`, git status, saved docs list; returns a ≤200-token briefing in a fixed shape. Refuses to infer next steps the snapshot didn't record.

### Added — subagent budget enforcement (TP-q33 part a)

Every `tp-*` agent declares `Response budget: ~N tokens` in its preamble. Until now, nothing enforced it.

- **`PostToolUse:Task` hook** — after a subagent returns, reads its frontmatter budget, counts tokens in the response (chars/4 heuristic), logs any over-run beyond 10 % tolerance to `.token-pilot/over-budget.log` as JSONL. Silent on every failure; telemetry must never break the agent loop.
- **Log schema:** `{ ts, agent, budget, actualTokens, overByRatio }`.
- **Scope:** only `tp-*` subagents — third-party `acc-*`, `feature-dev:*`, etc. are ignored (we only enforce contracts we own).
- **Zero API cost** — pure post-response analysis. Live-test-harness half (TP-q33 part b) still deferred; requires `ANTHROPIC_API_KEY`.

### Changed

- `.claude-plugin/hooks/hooks.json` and the installer now register a `PostToolUse:Task` matcher alongside the existing `Bash` matcher. Idempotent install; uninstall removes both.
- `typo-guard` KNOWN_COMMANDS expanded to include `hook-post-task`.

### Numbers
- 904 tests green (+14 post-task budget tests), `tsc --noEmit` clean.

## [0.22.3] - 2026-04-18

### Fixed

- **CLI typo guard** — mis-typed commands like `npx token-pilot install-aents` (missing `g`) used to silently become a `projectRoot=install-aents` MCP server launch and create stray `install-aents/.claude/settings.json` directories. Now the CLI detects command-shaped first args that aren't in the allow-list and aren't valid paths, prints `[token-pilot] Unknown command "install-aents". Did you mean "install-agents"?` on stderr, and exits non-zero. Levenshtein-based suggestion with a distance cap of 3.

### Numbers
- 890 tests green (+9 typo-guard regression tests), `tsc --noEmit` clean.

## [0.22.2] - 2026-04-18

### Fixed

- **`session_snapshot` silently dropped `decisions[]`** — the tool schema exposed the field and the renderer consumed it, but the server dispatch's inline cast type omitted it, so every snapshot lost its Decisions section. Fix: added `decisions?: string[]` to the cast. Regression-guarded by new `tests/handlers/session-snapshot.test.ts` covering every schema field.
- **Help text tool count out of date** — `token-pilot --help` said `MCP Tools (20)` but the server registers 22. Corrected count + listed all 22 (including `read_section` and `read_symbols`).
- **README doc drift** — hard-coded `(21)` in the MCP Tools heading and "six subagents" throughout. Replaced with count-free phrasing; added Tier 1 / Tier 2 tables covering all 11 subagents; added `session_budget` to the Session tools row.

### Changed

- **Session-registry flush on signal termination** — `SessionRegistryManager.flushAll()` is now wired to `SIGINT` and `SIGTERM` in addition to `beforeExit` (the latter doesn't fire on signal-based termination).
- Clarified the `shutdownFlush` comment about `process.exit()` limitations.
- Added a one-line intro to the README subagents section explaining the Tier 1 vs Tier 2 split.

### Numbers
- 881 tests green (+2 regression tests for `session_snapshot`), `tsc --noEmit` clean.

## [0.22.1] - 2026-04-18

### Added — TP-02l Tier 2 subagents (5 new)

Five more `tp-*` specialists, installed alongside the existing six via `npx token-pilot install-agents`:

- **`tp-debugger`** — bug diagnosis via call-tree traversal (`find_usages` + `read_symbol` + `smart_log`). Given a stack trace or error, finds the root-cause line without Reading whole files.
- **`tp-migration-scout`** — pre-migration impact map. Given a target (API, symbol, dependency), emits a file-by-file checklist grouped by effort class (trivial / local / cross-file / needs-design).
- **`tp-test-writer`** — writes tests for one specific symbol, mirroring the project's existing test style. Runs `test_summary` before declaring done — refuses to claim success on tests it didn't run.
- **`tp-dead-code-finder`** — cross-checks `find_unused` with Grep, recent git history, and dynamic-lookup patterns before recommending deletion. Output only — never deletes.
- **`tp-commit-writer`** — drafts a Conventional-Commit message from staged diff. Refuses to write when `test_summary` reports failures, when diff mixes types (asks to split), or when staged is empty.

Total subagents now: **11** (6 Tier 1 + 5 Tier 2). Build pipeline auto-discovers `tp-*.md` files — no config changes required.

### Numbers
- 879 tests green, `tsc --noEmit` clean.

## [0.22.0] - 2026-04-18

### Added — TP-69m session-scoped dedup

The `ContextRegistry` that remembers "this file / symbol / range is already in your context" used to live for the MCP server process lifetime — a restart or the way Claude Code spawns short-lived server instances threw the knowledge away. Now it is per-session and persisted to disk.

Four mechanics shipped together:

1. **`ContextRegistry` snapshot API** — new `toSnapshot()` / `loadSnapshot()` round-trip the state through plain JSON. Silent on malformed input (a broken snapshot file degrades to an empty registry, never crashes the server).
2. **`SessionRegistryManager`** — owns a map of session_id → registry, LRU-caps the live set (default 8 sessions in memory), reads/writes `.token-pilot/context-registries/<id>.json`. Unsafe ids (empty, traversal, slashes) get an ephemeral in-memory registry that is never persisted.
3. **Per-call `pickRegistry` in server.ts** — `smart_read`, `read_symbol`, `read_range`, `smart_read_many` now pick the right registry for each tool call based on args. No `session_id` → process-default (legacy behaviour). Flushes to disk after every successful dedup-aware call.
4. **`force: true` escape hatch** — new optional arg on the four dedup tools. When compaction has evicted an earlier result from the agent's window, `force: true` returns the full content instead of a "you already loaded this" pointer. Critical: without it, a session-scoped dedup pointing to a compacted turn would be an impossible-to-escape pit.

Schema additions on `smart_read` / `read_symbol` / `read_range` / `smart_read_many`: optional `session_id: string` and `force: boolean`. Backwards compatible — existing callers see no change.

Shutdown: `SessionRegistryManager.flushAll()` is attached to `process.beforeExit` so any registries that missed their post-call flush still land on disk.

### Numbers
- 879 tests green, `tsc --noEmit` clean.

## [0.21.2] - 2026-04-18

### Added
- **`session_snapshot` auto-persist + SessionStart resume pointer (TP-340)** — calling `session_snapshot` now writes the rendered block to `.token-pilot/snapshots/<iso>.md` and `latest.md` (opt-out via `persist: false`). SessionStart hook surfaces a one-line pointer when the latest snapshot is fresh (<24h), so a new window after `/clear`, compaction, or a fresh process can pick up the thread without re-hydrating context by hand. Retention keeps the last 10 archived snapshots.
- **`session_budget` MCP tool (TP-hsz batch A)** — new tool reports the live session's saved tokens, configured budget, burn fraction (clamped 0..1), base threshold, and the effective threshold the adaptive curve would apply right now. Small payload (~80 tokens) — the agent can poll cheaply before a big read to decide whether to tighten up.
- **Context-mode auto-suggest in Bash advisor (TP-hsz batch A)** — when `.mcp.json` advertises context-mode, the large-Bash-output advisory now mentions `mcp__context-mode__execute` as an option (sandbox keeps stdout out of the window). Sync detector — no async plumbing added to the hook.
- **Time-to-compact projection in `session_budget` (TP-hsz batch B)** — payload now includes `eventCount`, `avgSavedPerEvent`, `eventsUntilExhaustion`, `firstEventMs`, `lastEventMs`. Agent can see how many more same-shape turns the adaptive budget will tolerate at the current burn rate.

### Changed
- **Snapshot resume pointer is tighter and more informative** — SessionStart "fresh snapshot" window narrowed from 24h to 2h (an unrelated next-day task shouldn't inherit yesterday's thread) and now surfaces the snapshot's `Goal:` extract inline so the agent can eyeball relevance before reading `latest.md`.
- **Clarified adaptive-threshold / `session_budget` semantics** — `burnFraction` is Read-hook suppression pressure, NOT context-window occupancy. Token Pilot has no visibility into actual window state; the new docstrings and tool descriptions say so explicitly, and the `session_budget` payload carries a `semantics:` hint. No behaviour change; naming-only clarification before TP-69m builds on the same signal.

### Numbers
- 873 tests green, `tsc --noEmit` clean.

## [0.21.1] - 2026-04-18

### Added
- **Adaptive Read-hook threshold (TP-bbo)** — opt-in `hooks.adaptiveThreshold` auto-lowers `denyThreshold` as the current session burns through `hooks.adaptiveBudgetTokens` (default 100k). Piecewise curve: unchanged below 30% burn, ×0.75 at 30–60%, ×0.5 at 60–80%, ×0.3 (floor 50 lines) beyond. Burn is read from `.token-pilot/hook-events.jsonl` `savedTokens` for the live `session_id`. Default off — zero behaviour change unless the user enables it. Env overrides: `TOKEN_PILOT_ADAPTIVE_THRESHOLD`, `TOKEN_PILOT_ADAPTIVE_BUDGET`.
- **Save-doc CLI (TP-89n)** — `token-pilot save-doc <name>` persists any stdin text (curl, WebFetch, long research notes) to `.token-pilot/docs/<name>.md` so it survives compaction and can be re-read cheaply with `smart_read` / `read_range` instead of refetching the external source. `token-pilot list-docs` enumerates saved docs. Name validation refuses traversal / path separators; overwrite is explicit (`--overwrite`).

### Numbers
- 862 tests green, `tsc --noEmit` clean.

## [0.21.0] - 2026-04-18

### Added
- **`doctor` Claude Code env-var advisor (TP-c08)** — surfaces the four knobs the community guide flags as giving 60-80% session savings with zero code change (`CLAUDE_CODE_SUBAGENT_MODEL=haiku`, `MAX_THINKING_TOKENS=10000`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50`, `model=sonnet`). Pure advisory — never modifies user settings; reads both `process.env` and `~/.claude/settings.json` with fallback semantics.
- **`.claudeignore` generator (TP-rtg)** — `token-pilot init` now offers to create a `.claudeignore` with sensible defaults (node_modules, dist, build, __pycache__, lockfiles, source maps, …). Non-destructive: carries a magic-comment marker so re-runs refresh our own file in place but never clobber user-owned `.claudeignore`. `doctor` reports current status.
- **CLAUDE.md hygiene check in `doctor` (TP-rtg)** — warns when `CLAUDE.md` exceeds 60 non-empty lines (that file loads into every Claude Code message; long rules are per-turn tax). Read-only; counts ignore blank lines and markdown horizontal rules.
- **Bash output advisor (TP-jzh)** — new `PostToolUse:Bash` hook. When Bash stdout exceeds ~8000 characters, the hook appends a single-line `additionalContext` tip pointing the agent at cheaper alternatives (`mcp__token-pilot__test_summary` for test runs, bounded commands, head/tail piping). Cannot truncate output in-flight — Claude Code's PostToolUse is observational for non-MCP tools — but steers the next turn.

### Changed
- `.claude-plugin/hooks/hooks.json` and the installer now register the new PostToolUse:Bash hook alongside Read/Edit/SessionStart. Idempotent install adds it without touching existing hooks; uninstall removes PostToolUse too.

### Numbers
- 843 tests green, `tsc --noEmit` clean.

## [0.20.2] - 2026-04-18

### Changed
- **`token-pilot init` now offers to install tp-* subagents** — after writing `.mcp.json`, if a TTY is attached the command asks `Install 6 tp-* subagents now? [Y/n]`. If yes, delegates to the full `install-agents` flow (scope prompt, idempotence, persistence). In non-TTY the next-step hint is printed instead of asking. Closes the gap where first-time users left `init` thinking everything was ready and only learned about subagents from a later stderr reminder.
- **Refreshed the init success message** — replaced the v0.13-era "AST-aware code reading (60-80% token savings)" line with a description of the v0.20 enforcement-layer scope.

## [0.20.1] - 2026-04-18

### Fixed
- **hook-events.jsonl not written** — the writeEvent helper in the hook dispatcher was fire-and-forget (`void appendEvent(...)`). `process.exit(0)` raced with the async fs write, so every event was silently dropped. Now awaits the write before returning. `token-pilot stats` and `stats --by-agent` finally show real data.

## [0.20.0] - 2026-04-18

### Added
- **Enforcement layer (TP-816)** — four-component architecture that makes token-pilot actually used, not just advertised.
  - **`deny-enhanced` hook mode** (new default) — `PreToolUse:Read` on qualifying large code files returns a structural summary (imports, exports, declarations, head/tail fallback) **inside the denial reason**. Works for every agent, including subagents that lack MCP access. `advisory` and `off` modes remain available.
  - **SessionStart hook** — emits a one-shot reminder after every `/clear` / `/compact` / new session, listing the mandatory MCP tools and the installed `tp-*` subagents. Respects `sessionStart.enabled` independently of `hooks.mode`.
  - **`bless-agents` CLI** — scans installed agents, classifies by tool-allowlist shape (wildcard / exclusion / explicit), and writes project-level overrides adding `mcp__token-pilot__*` to category-C agents. `unbless-agents` + `doctor` upstream-drift detection close the loop.
  - **Subagent family (`tp-*`)** — six Tier-1 agents with tight response budgets and verdict-first output contract: `tp-run` (800), `tp-onboard` (600), `tp-pr-reviewer` (600), `tp-impact-analyzer` (400), `tp-refactor-planner` (500), `tp-test-triage` (500). Installed via `npx token-pilot install-agents` (user or project scope, idempotent with body-hash).
- **`install-agents` / `uninstall-agents` CLI** — scope resolution (flag > persisted > prompt > error), idempotence matrix (unchanged / template-upgraded / user-edited / no-hash), `--force` to overwrite user-edited (never touches files without our marker).
- **MCP startup reminder** — one-time stderr nudge when no `tp-*` agents are installed; silenced by `agents.reminder: false` or `TOKEN_PILOT_NO_AGENT_REMINDER=1`; suppressed inside subagents via `TOKEN_PILOT_SUBAGENT=1`.
- **`hook-events.jsonl` telemetry** — new schema `{ts, session_id, agent_type, agent_id, event, file, lines, estTokens, summaryTokens, savedTokens}`; rotates at 10 MB, retains 30 days / 100 MB.
- **`stats` CLI** — `token-pilot stats` (default totals + top files), `--session[=<id>]` (filter to one session, most recent by default), `--by-agent` (group by `agent_type`, null rendered as "main").
- **`bench:hook` script** — `npm run bench:hook` reports p50/p95/p99 hook latency against a 1000-line fake file; thresholds from TP-816 §11 available as opt-in `--check=true` gate.

### Changed
- **Config** — new fields: `hooks.mode` (`off` | `advisory` | `deny-enhanced`, replaces legacy boolean `hooks.enabled`), `sessionStart.*`, `agents.scope`, `agents.reminder`, `hooks.migratedFrom`.
- **Legacy migration** — `hooks.mode: "deny"` (v0.19) is rewritten to `"advisory"` on next load with a one-time stderr notice and `hooks.migratedFrom: "deny"` marker. Old `hooks.enabled: false` is migrated to `mode: "off"`. Both are idempotent.
- **Env vars** — `TOKEN_PILOT_DENY_THRESHOLD=<n>` overrides `hooks.denyThreshold`. Documented alongside `TOKEN_PILOT_MODE`, `TOKEN_PILOT_BYPASS`, `TOKEN_PILOT_DEBUG`, `TOKEN_PILOT_NO_AGENT_REMINDER`, `TOKEN_PILOT_SUBAGENT`.

### Deferred
- **Live-LLM behavioural assertions** — the agent-behaviour acceptance ("uses MCP before raw Read; response within budget; no narration") requires a live Anthropic or Claude Code runner. Deterministic coverage (structure, budget ceiling, fixture compat) is in place; live dispatch moves to a v0.20.x follow-up.
- **Claude Code marketplace plugin** — planned for a future release; `install-agents` remains the supported path.

### Numbers
- 806 tests green, `tsc --noEmit` clean.

## [0.19.2] - 2026-04-15

### Added
- **npm-first binary install** — `install-ast-index` now tries `npm install -g @ast-index/cli` before falling back to GitHub download. Works on all platforms including Windows (no more "ZIP extraction not supported" error).
- **npm binary discovery** — `findBinary` now checks the npm global prefix (`npm config get prefix`) as a 3rd resolution strategy: config → system PATH → npm global → managed install.

### Fixed
- **Hook installer uses absolute paths** — hooks now write `<node> <script> hook-read` instead of bare `token-pilot hook-read`. Fixes `token-pilot: not found` in `/bin/sh` environments (nvm, npx, non-login shells).
- **Skip auto-install when running as plugin** — when `CLAUDE_PLUGIN_ROOT` is set, the MCP server no longer writes duplicate hooks into `.claude/settings.json`.
- **Auto-upgrade broken hooks** — old hooks with bare `token-pilot` commands are automatically replaced with absolute-path versions on next server start.

### Changed
- **`BinaryStatus.source`** now includes `'npm'` as a value (shown in `doctor` and `session_analytics`).
- **`search()` supports `--type` filter** — filter results by symbol type (`class`, `function`, `interface`, etc.). Leverages ast-index ≥3.30.0.
- **`hierarchy()` supports `--in-file` / `--module` filters** — scope class hierarchy queries by filename or module path. Leverages ast-index ≥3.30.0.
- **498 tests** (was 492).

## [0.19.1] - 2026-04-15

### Added
- **`decisions` field in `session_snapshot`** — stores key decisions with reasoning (e.g., "removed sysfee step — caused double counting"). Prevents the model from revisiting rejected approaches after context compaction.

## [0.19.0] - 2026-04-15

### Added
- **`session_snapshot` tool** — capture current session state (goal, confirmed facts, files, blockers, next step) as a compact markdown block (<200 tokens). Call before context compaction or when switching direction in long sessions.
- **`max_tokens` parameter** on `smart_read` and `smart_read_many` — token budget per read. Output auto-downgrades through three levels: full content → structural outline → compact (symbol names + line ranges only). Enables context-constrained sessions.
- **Session compaction advisory** — policy engine now tracks total tool calls and tokens returned. Advises calling `session_snapshot()` when thresholds are reached (default: every 15 calls or after 8,000 tokens). Configurable via `compactionCallThreshold` and `compactionTokenThreshold`.
- **"Why This Approach Works"** section in README explaining the 3-level optimization strategy.

### Changed
- **21 tools** (was 20) — added `session_snapshot`.
- **MCP instructions** updated with `session_snapshot` workflow and `max_tokens` guidance.
- Benchmark numbers updated: 55 files, 102K raw → 9K outline tokens (91% savings).

## [0.18.1] - 2026-04-13

### Fixed
- **Hook installer uses absolute paths** — hooks now write `<node> <script> hook-read` instead of bare `token-pilot hook-read`. Fixes `token-pilot: not found` errors in `/bin/sh` environments (nvm, npx, non-login shells).
- **Skip auto-install when running as plugin** — when `CLAUDE_PLUGIN_ROOT` is set, the MCP server no longer writes duplicate hooks into `.claude/settings.json` (the plugin system handles this via `hooks.json`).
- **Auto-upgrade broken hooks** — old hooks with bare `token-pilot` commands are automatically replaced with absolute-path versions on next server start.

### Changed
- **495 tests** (was 492).

## [0.18.0] - 2026-04-05

### Added
- **`read_section` tool** — read a specific section from Markdown, YAML, JSON, or CSV files. Markdown: by heading name. YAML/JSON: by top-level key. CSV: by row range (`rows:1-50`). Much cheaper than reading the whole file.
- **`read_for_edit` section parameter** — prepare edit context for non-code file sections. Works with all 4 formats.
- **Markdown outline with line ranges** — `smart_read` on `.md` files now shows `[L5-20]` ranges and hints for `read_section`.
- **YAML/JSON section ranges** — `smart_read` on `.yaml`/`.json` shows top-level key ranges.
- **CSV smart_read** — shows columns, row count, sample rows, and hints for row-range reading.
- **4 section parsers** — `markdown-sections.ts`, `yaml-sections.ts`, `json-sections.ts`, `csv-sections.ts`.

### Changed
- **20 tools** (was 19) — added `read_section`.
- **492 tests** (was 441).

### Fixed
- `npm audit` — resolved brace-expansion, path-to-regexp, picomatch vulnerabilities.

## [0.17.0] - 2026-04-02

### Added
- **`smart_read` scope parameter** — `scope="nav"` returns names + line ranges only (2-3x smaller), `scope="exports"` shows only public API. Default `scope="full"` unchanged.
- **`smart_read` auto-delta** — when a file changed since last load (within 120s), shows ADDED/REMOVED/UNCHANGED symbols instead of full re-read. Config: `smartRead.autoDelta.enabled`.
- **`read_symbol` include_edit_context** — optional `include_edit_context=true` appends raw code block (max 60 lines) to save a separate `read_for_edit` call. Large symbols fall back to `read_for_edit`.
- **`find_usages` mode=list** — compact `file:line` output for initial discovery, 5-10x smaller than full mode.
- **`smart_read_many` per-file dedup** — skips files already in context and unchanged, returns compact reminder instead.
- **Actionable hints** — `read_for_edit` suggests `read_diff` after editing. Config: `display.actionableHints`.
- **`symbol-display-constants.ts`** — shared display constants for symbol rendering.

### Changed
- **441 tests** (was 427) — new tests for scope, list mode, include_edit_context, dedup.
- **MCP instructions** updated with scope/mode/include_edit_context guidance.
- **find_usages context rendering** — sequential instead of concurrent to prevent shared cache race condition.

## [0.16.1] - 2026-03-21

### Added
- **Hook interception tracking** — PreToolUse hook now records denied Read calls (file path, line count, estimated tokens) to `.token-pilot/hook-denied.jsonl`. Session analytics shows how many tokens the hook saved by intercepting unbounded reads on large code files.
- **`session_analytics` hook savings** — compact report adds "Hook: intercepted N reads, saved ~X tokens" line. Verbose mode shows per-file breakdown of intercepted reads.

## [0.16.0] - 2026-03-21

### Added
- **`read_symbols` tool** — batch read multiple symbols from one file in a single call (max 10). File is read once, AST resolved once. Saves N-1 round-trips vs calling `read_symbol` N times.
- **`read_for_edit` batch mode** — new `symbols` array parameter reads multiple symbol edit contexts in one call. Each symbol returns raw code ready for Edit tool's `old_string`.
- **`find_usages` context_lines** — new `context_lines` parameter (0-10) shows surrounding source code for each match. Eliminates follow-up `read_symbol` calls after finding usages.
- **`smart_diff` affected symbols summary** — consolidated "AFFECTED SYMBOLS" section at the top of diff output, grouped by MODIFIED/ADDED/REMOVED. See all changed functions/classes at a glance.

### Changed
- **19 tools** (was 18) — added `read_symbols`.
- **MCP instructions** — added batch read_symbols to decision rules and refactor workflow.
- **427 tests** (unchanged — all pass with new features).

## [0.15.0] - 2026-03-19

### Added
- **Regex fallback parser (TS/JS)** — `smart_read` now works for TypeScript/JavaScript files even without ast-index binary. Parses classes, functions, interfaces, types, enums, and class methods via regex. Zero dependencies, 130 lines. Covers ~80% of new users who fail to download ast-index.
- **Regex fallback parser (Python)** — `smart_read` now works for Python files without ast-index. Parses classes, functions, async functions, decorators (`@dataclass`, `@app.route`), module constants (`UPPER_CASE`), methods with visibility detection (`_private`, `__dunder__`). 150 lines.
- **Benchmark script** — `scripts/benchmark.ts` measures real token savings on public repos (express, fastify, flask). 92% average savings across 97 files ≥50 lines. Run: `npx tsx scripts/benchmark.ts`.
- **Guide skill** — `/guide` command shows a quick-reference table of all Token Pilot tools with usage examples and recommended workflow.
- **`hooks.denyThreshold` config** — hook deny threshold is now configurable in `.token-pilot.json` (default: 300, was hardcoded 500). Intercepts ~2x more native Read calls.

### Changed
- **Compact session analytics** — `session_analytics` report reduced from ~30 lines to ~5 lines. Shows calls, tokens saved, top 5 tools, top 3 files, cache hit rate on a single screen. Verbose mode (`verbose=true`) restores full breakdown.
- **`server.ts` refactor** — extracted tool definitions to `server/tool-definitions.ts` and token estimate helpers to `server/token-estimates.ts` (−500 lines from server.ts).
- **`find_usages` output** — results grouped by file with compact rendering. Single match per file on one line, multiple matches indented under file header.
- **Stale references** — all `grep_search` hints updated to `Grep` (code-audit, find-unused, find-usages).
- **README** — benchmark table with real data from 4 public repos. Updated savings claims from 80% to 90% (backed by benchmark).
- **427 tests** (was 393).

### Fixed
- **`npx token-pilot` CLI** — symlink path resolution in `isDirectRun` check. All CLI commands now work correctly via npx.
- **Regex fallback was dead code** — parsers existed but weren't wired into `client.ts` `outline()` method. Now properly called as fallback when ast-index unavailable.

## [0.14.1] - 2026-03-14

### Fixed
- **CI: Node.js 24 runtime** — opted into `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` for GitHub Actions, resolving deprecation warnings for `actions/checkout@v4` and `actions/setup-node@v4`.
- **CI: test matrix** — updated from Node 18+22 to Node 20+22 (Node 18 is EOL).
- **Test: git commit in CI** — `read-for-edit` tests now pass `-c user.name` / `-c user.email` to `git commit`, fixing failures in environments without global git config.

## [0.14.0] - 2026-03-14

### Added
- **R&D Track 0: Instrumentation** — per-call decision trace capturing file size, context state, estimated vs actual cost, and cheaper alternative suggestions. Integrated into all 18 tool handlers via `recordWithTrace()`.
- **R&D Track 1: Budget Planner** — advisory layer suggesting cheaper tool alternatives (e.g. `smart_read` → `read_diff` when file already in context, → `read_symbol` when symbol known). Analytics-only, no blocking.
- **R&D Track 2: Intent Router** — classifies tool calls into 7 intents (edit/debug/explore/review/analyze/search/read). Per-intent breakdown in session analytics.
- **R&D Track 3: Edit Prep Mode** — `read_for_edit` with `include_callers`, `include_tests`, `include_changes` enrichment options.
- **R&D Track 4: Session Cache** — tool-result-level caching with file/AST/git invalidation.
- **R&D Track 5: Confidence-Based Escalation** — confidence metadata (high/medium/low) appended to `smart_read`, `read_symbol`, `read_for_edit`, `find_usages` responses. Shows known unknowns and suggested next steps.
- **R&D Track 6: Working Set / Dedup** — compact reminders for already-loaded files and symbols.
- **R&D Track 7: Related Files Ranking** — scored ranking with 6 signals (test +5, import +4, importer +3, same-dir +2, recently-changed +2, multi-ref +1). HIGH VALUE / MEDIUM / LOW buckets.
- **R&D Track 8: Architecture Fingerprint** — caches architecture in `.token-pilot-fingerprint.json` (24h TTL). Amortizes `project_overview` cost across sessions.
- **R&D Track 9: Verified Savings Dashboard** — savings breakdown by category (compression/cache/dedup), session cache hit rate, dedup stats.
- **R&D Track 10: Team Policy Mode** — configurable policies: `preferCheapReads`, `maxFullFileReads`, `warnOnLargeReads`, `requireReadForEditBeforeEdit`.
- **7 new core modules** — `confidence.ts`, `intent-classifier.ts`, `budget-planner.ts`, `decision-trace.ts`, `session-cache.ts`, `architecture-fingerprint.ts`, `policy-engine.ts`.
- **35 new tests** — confidence (11), architecture-fingerprint (11), policy-engine (13). Total: 393 tests.

### Changed
- **`session_analytics`** — per-intent breakdown, decision insights, savings by category.
- **`project_overview`** — saves/loads architecture fingerprint for cross-session caching.
- **Config** — added `policies` section to `TokenPilotConfig`.

## [0.13.0] - 2026-03-14

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
