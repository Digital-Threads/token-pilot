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
| `haiku` | 5 | Mechanical work — extract, list, reformat against a fixed shape |
| `sonnet` | 20 | Judgement — decide what matters, what breaks, why it is so |

### How the line is drawn

Measured on identical prompts through `tp-run`:

| Task | Haiku | Sonnet |
|------|------:|-------:|
| List exported symbols in a file (strict output format) | **19,020 tok · 9.4s**, format followed exactly | 25,798 tok · 12.6s, added a verdict line the prompt forbade |
| Find a defect in a decision function | 27,916 tok · 89s, found a narrow type issue | **30,307 tok · 50s**, found the functional defect and answered the follow-up |

So haiku is the better tool for shape-bound work — cheaper, quicker, and more literal about the format. Sonnet is the better tool the moment the answer requires deciding what is important, because that is exactly where haiku's answer was narrower.

Two things follow. First, most of the cost is subagent startup, not generation: the gap between models is 8–26%, while dispatching to `general-purpose` instead of a specialist costs 3x. Picking the model is a small optimisation; picking the agent is a large one. Second, because the gap is small, **when a task is borderline, choose sonnet** — a wrong answer costs more than the model does.

The five on haiku all produce output with a predetermined shape: a commit message, an orientation map, a session briefing, a coverage list, a chain of commits quoted without interpretation. Anything that weighs, ranks, or explains is on sonnet — including `tp-run`, whose whole purpose is to take work no specialist claimed, so its difficulty is unknown in advance.

## Third-party Agent Integration (bless-agents)

For third-party agents (e.g. `acc-*` plugins) whose tool allowlist excludes token-pilot MCP:

```bash
npx token-pilot bless-agents       # add token-pilot MCP to project-level overrides
npx token-pilot unbless-agents <name>... | --all
```

`doctor` warns when the original agent has changed since blessing.
