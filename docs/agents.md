# tp-* Subagents (Claude Code only)

`tp-*` subagents are a Claude Code feature. Other clients get the MCP tools + hooks but cannot invoke subagents. Each agent carries an explicit `model:` field in its frontmatter; the budget is enforced post-response — overshoots beyond 10% land in `.token-pilot/over-budget.log`.

## Installation

```bash
npx token-pilot install-agents --scope=user            # all projects
npx token-pilot install-agents --scope=project         # this repo only
npx token-pilot install-agents --scope=user --force    # re-apply after an update
npx token-pilot uninstall-agents --scope=user|project
```

`init` offers to install these; to add them to another project run `npx token-pilot install-agents`.

## Tier 1 — Workhorses (invoke proactively)

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-run` | General MCP-first workhorse; use when no specialised agent fits | 800 |
| `tp-onboard` | Orient to an unfamiliar repo (layout, entry points, modules) | 600 |
| `tp-pr-reviewer` | Review a diff / PR / changeset; verdict-first, Critical/Important tiers | 600 |
| `tp-impact-analyzer` | Trace blast-radius of a change (callers, transitive deps) | 400 |
| `tp-refactor-planner` | Plan a refactor with exact edit context per step | 500 |
| `tp-test-triage` | Investigate test failures → root cause → minimal fix | 500 |

## Tier 2 — Specialists

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-debugger` | Stack trace / error → root-cause line via call-tree traversal | 700 |
| `tp-migration-scout` | Pre-migration impact map grouped by effort class | 800 |
| `tp-test-writer` | Write tests for ONE symbol, mirrors project style, runs tests | 900 |
| `tp-dead-code-finder` | Cross-checked dead-code detection, output-only (never deletes) | 600 |
| `tp-commit-writer` | Draft Conventional-Commit from staged diff; refuses failing tests | 400 |
| `tp-history-explorer` | "Why is this like this?" — minimum commit chain explaining current state | 600 |
| `tp-audit-scanner` | Read-only security / quality audit; Critical / Important / Minor findings | 800 |
| `tp-session-restorer` | Rehydrate state after /clear or compaction from latest snapshot | 400 |

## Tier 3 — Combo / Workflow

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-review-impact` | Pre-merge blast-radius review (diff × dependents × API surface) | 700 |
| `tp-test-coverage-gapper` | Find symbols with zero test references, prioritised | 500 |
| `tp-api-surface-tracker` | Public API diff vs last release → MAJOR / MINOR / PATCH verdict | 600 |
| `tp-dep-health` | Dep audit: stale × heavily-used × removable | 600 |
| `tp-incident-timeline` | Correlate an incident window with commits, rank likely culprits | 700 |

## Tier 4 — Methodology

| Agent | When to invoke | Budget |
|-------|---------------|-------:|
| `tp-context-engineer` | Audit / write CLAUDE.md / AGENTS.md rules files per project | 800 |
| `tp-spec-writer` | Pre-code spec with gated workflow; surfaces assumptions before code | 900 |
| `tp-performance-profiler` | Measure → identify → fix → verify → guard; refuses to optimise without data | 800 |
| `tp-incremental-builder` | Multi-file feature work in thin vertical slices, test between each | 900 |
| `tp-doc-writer` | ADRs + READMEs + API docs; documents *why* not *what* | 700 |
| `tp-ship-coordinator` | 5-pillar pre-launch checklist (quality / security / observability / rollback / rollout) | 800 |

## Model Tiers

Every agent carries an explicit `model:` field:

| Model | Count | Used for |
|-------|------:|---------|
| `haiku` | 9 | Structured / format-bound output (commit messages, onboarding maps, ADRs, session briefings) |
| `sonnet` | 15 | Reasoning tasks (review, debug, test, plan, audit, spec, profile, ship) |
| `inherit` | 1 | Deep correlation needing the main thread's model (`tp-incident-timeline`) |

Under Opus 4.7's +35% tokenizer tax, keeping the majority of agent spawns on haiku/sonnet saves 5–10× model cost vs an all-Opus baseline.

## Third-party Agent Integration (bless-agents)

For third-party agents (e.g. `acc-*` plugins) whose tool allowlist excludes token-pilot MCP:

```bash
npx token-pilot bless-agents       # add token-pilot MCP to project-level overrides
npx token-pilot unbless-agents <name>... | --all
```

`doctor` warns when the original agent has changed since blessing.
