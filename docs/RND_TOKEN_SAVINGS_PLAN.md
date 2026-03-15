# Token Savings R&D Plan

## Goal

Increase real token savings without degrading answer quality or response speed.

Target outcome for the next major product cycle:

- Raise typical session savings from `25-45%` to `40-65%`
- Keep median extra tool latency under `250ms` for cheap routing decisions
- Avoid quality regression in code-edit and debugging workflows
- Make savings auditable instead of purely heuristic

This plan is intentionally grounded in the current codebase:

- request routing and analytics live mostly in [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)
- session reporting lives in [src/core/session-analytics.ts](/home/shahinyanm/www/token-pilot/src/core/session-analytics.ts)
- code-reading primitives already exist in `smart_read`, `read_symbol`, `read_range`, `read_diff`, `read_for_edit`, `related_files`, `find_usages`, `project_overview`, `explore_area`

## Product Thesis

Token savings should come from reading less code, not from compressing more text.

The strongest path is:

1. choose the cheapest sufficient tool first
2. avoid repeated reads of known facts
3. expand context only when confidence is low
4. measure savings against realistic manual workflows

## North-Star Metrics

These should be tracked before shipping major routing changes.

### Savings Metrics

- `session_token_reduction_pct`
- `tokens_saved_total`
- `tokens_saved_by_tool`
- `verified_tokens_saved_total`
- `manual_workflow_baseline_tokens`

### Quality Metrics

- `edit_success_rate`
- `answer_revision_rate`
- `followup_read_rate`
- `escalation_rate_after_cheap_read`

### Speed Metrics

- `median_tool_latency_ms`
- `p95_tool_latency_ms`
- `routing_overhead_ms`
- `cache_hit_rate`

### Trust Metrics

- `savings_claim_error_rate`
- `false_cheap_path_rate`
- `full_read_avoided_rate`

## Constraints

- No savings feature should force worse answers just to look efficient
- Routing logic must be deterministic enough to debug
- New heuristics should be observable in analytics
- Cheap-path failures must degrade upward gracefully into broader context

## Current Strengths

- Strong low-token primitives already exist
- Session analytics now report savings more honestly
- `read_for_edit`, `read_range`, `read_symbol`, and `smart_read` are already good economic building blocks
- Integration coverage is now strong enough to support iterative experiments safely

## Current Gaps

- Tool selection is still mostly user-driven rather than intent-driven
- Savings are measured after the fact more often than optimized before the read
- Context is not reused aggressively enough between adjacent steps
- Multi-file workflows still expand more than they need to
- Overview tools still rely partly on heuristics rather than explicit routing policy

## R&D Tracks

## Track 0: Instrumentation First

### Why

Before pushing stronger optimization, the project needs tighter measurement. Otherwise the product may optimize for pretty metrics instead of real cost reduction.

### Hypothesis

Adding pre-read and post-read instrumentation will make future routing changes safer and easier to validate.

### Proposed Work

- Add a `decision_trace` object to each analytics event
- Log:
  - chosen tool
  - candidate tools considered
  - estimated token cost for each candidate
  - reason for escalation
  - confidence before and after read
- Distinguish:
  - `estimated_savings`
  - `verified_savings`
  - `avoided_full_read`

### Likely Code Touchpoints

- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)
- [src/core/session-analytics.ts](/home/shahinyanm/www/token-pilot/src/core/session-analytics.ts)

### Success Criteria

- Every major tool call can explain why it was chosen
- Savings reports separate heuristic and verified claims
- We can compare cheap-path vs expanded-path sessions

### Priority

`P0`

## Track 1: Context Budget Planner

### Why

Right now token efficiency depends too much on manually choosing the right tool.

### Hypothesis

A lightweight planner that selects the cheapest sufficient read strategy before execution will reduce waste materially without hurting quality.

### Proposed Feature

Introduce a planner that scores candidate actions for a request:

- `read_symbol`
- `read_range`
- `read_for_edit`
- `read_diff`
- `smart_read`
- `smart_read_many`
- raw fallback

The planner should consider:

- task type
- file size
- file type
- whether target symbol is known
- whether file changed recently
- whether this file was already summarized
- whether the user is editing or analyzing

### Suggested Design

- Add a `planReadStrategy()` helper
- Return:
  - `selectedTool`
  - `rejectedAlternatives`
  - `estimatedTokenCost`
  - `confidence`
  - `fallbackPolicy`

### Likely Code Touchpoints

- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)
- new helper under `src/core/`

### MVP Rollout

Phase 1:

- planner used only for analytics simulation

Phase 2:

- planner starts advising

Phase 3:

- planner actively routes default workflows

### Success Criteria

- `10-15%` reduction in avoidable full-file reads
- no material increase in escalation-related rereads

### Priority

`P0`

## Track 2: Intent Router

### Why

Savings increase when the system knows whether the user is debugging, editing, reviewing, exploring, or tracing a dependency.

### Hypothesis

Task-aware routing will outperform generic routing because the cheapest sufficient context differs by workflow.

### Proposed Intents

- `edit_symbol`
- `bugfix_trace`
- `review_change`
- `explore_module`
- `understand_project`
- `investigate_test_failure`
- `search_usage`

### Routing Examples

- `edit_symbol`:
  - prefer `read_for_edit` -> `related_files` -> `read_range`
- `review_change`:
  - prefer `read_diff` -> `read_symbol`
- `bugfix_trace`:
  - prefer `find_usages` -> `related_files` -> `smart_read`
- `understand_project`:
  - prefer `project_overview` -> `explore_area`

### Likely Code Touchpoints

- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)
- possibly a new `src/core/intent-router.ts`

### Success Criteria

- better first-tool selection rate
- lower median reads per solved task

### Priority

`P0`

## Track 3: Edit Prep Mode

### Why

Editing workflows are usually the highest-value token-saving path because agents tend to over-read before patching code.

### Hypothesis

A dedicated edit preparation mode can reduce edit-session token usage sharply without hurting patch quality.

### Proposed Feature

When task intent is edit-oriented:

- prefer `read_for_edit`
- attach nearest declaration and local neighbors
- optionally include recent diff context
- include only the minimum stable old-string zone

### Likely Enhancements

- enrich `read_for_edit` with optional:
  - `includeCallers`
  - `includeTests`
  - `includeRecentChanges`
- expose a compact `edit_bundle` response format

### Likely Code Touchpoints

- [src/handlers/read-for-edit.ts](/home/shahinyanm/www/token-pilot/src/handlers/read-for-edit.ts)
- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)

### Success Criteria

- `20-35%` lower tokens in edit-heavy sessions
- no drop in accepted patch quality

### Priority

`P0`

## Track 4: Semantic Context Cache

### Why

Repeated reading of the same code facts is one of the biggest hidden cost leaks in agent sessions.

### Hypothesis

Caching semantic results instead of only raw file state will cut repeat-cost substantially in multi-step workflows.

### Proposed Cache Entries

- file summary
- outline result
- related-files graph
- usage summary
- overview summary
- extracted symbol facts

### Invalidation Inputs

- file hash
- git diff
- mtime
- dependency edge changes

### Likely Code Touchpoints

- [src/core/file-cache.ts](/home/shahinyanm/www/token-pilot/src/core/file-cache.ts)
- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)

### Success Criteria

- materially higher cache-hit rate
- lower repeated-tool token baseline
- no stale-context bug spike

### Priority

`P1`

## Track 5: Confidence-Based Escalation

### Why

Savings become fake if cheap reads force a second or third read immediately after.

### Hypothesis

Adding confidence scoring and explicit escalation rules will protect answer quality while preserving cheap wins where safe.

### Proposed Feature

Every routed read returns:

- `confidence`
- `known_unknowns`
- `recommended_next_step`

Escalation triggers:

- missing symbol body
- conflicting definitions
- ambiguous ownership
- cross-file dependency uncertainty
- edit requires exact raw code beyond current slice

### Likely Code Touchpoints

- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)
- selected handlers that already summarize or slice content

### Success Criteria

- lower false-cheap-path rate
- stable answer quality
- lower reread churn

### Priority

`P1`

## Track 6: Task-Scoped Working Set

### Why

Agents waste tokens when context expands laterally without a clear task boundary.

### Hypothesis

Maintaining a bounded working set per task will stop unproductive context sprawl.

### Proposed Feature

Track:

- files already relevant to the task
- files rejected as low-value
- escalation boundary
- optional task label

Add heuristics:

- avoid reopening low-value files
- prefer files inside current working set
- require stronger signal before crossing module boundaries

### Likely Code Touchpoints

- [src/core/context-registry.ts](/home/shahinyanm/www/token-pilot/src/core/context-registry.ts)
- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)

### Success Criteria

- fewer lateral reads per task
- lower average files touched per solved task

### Priority

`P1`

## Track 7: Related Files Ranking

### Why

Returning many related files is helpful, but opening all of them destroys savings.

### Hypothesis

Ranking related files by probable task value will outperform flat related-file expansion.

### Proposed Ranking Signals

- same symbol chain
- recent edit proximity
- import closeness
- test adjacency
- call graph proximity
- config relevance
- path similarity

### Output Shape

Return:

- `high_value`
- `secondary`
- `deferred`

### Likely Code Touchpoints

- [src/handlers/related-files.ts](/home/shahinyanm/www/token-pilot/src/handlers/related-files.ts)
- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)

### Success Criteria

- fewer low-value follow-up reads
- lower cost in debugging and onboarding flows

### Priority

`P1`

## Track 8: Architecture Fingerprint

### Why

Project-wide understanding is expensive when reconstructed every session from scratch.

### Hypothesis

A durable architecture fingerprint will amortize overview cost across the session and future runs.

### Proposed Artifact

A lightweight machine-readable map containing:

- project type
- module layout
- test layout
- entrypoints
- common dependency chains
- naming conventions
- likely edit hotspots

### Possible Sources

- `project_overview`
- `module_info`
- `related_files`
- `find_usages`
- config file scan

### Likely Code Touchpoints

- [src/handlers/project-overview.ts](/home/shahinyanm/www/token-pilot/src/handlers/project-overview.ts)
- [src/handlers/module-info.ts](/home/shahinyanm/www/token-pilot/src/handlers/module-info.ts)
- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)

### Success Criteria

- cheaper repeated onboarding
- cheaper repeated root-cause analysis

### Priority

`P2`

## Track 9: Verified Savings Analytics

### Why

The product becomes much more valuable when savings are believable enough to sell and defend.

### Hypothesis

Separating estimated, verified, and avoided-read savings will improve product trust and guide product work better.

### Proposed Reporting

Per tool and per session, show:

- `estimated_saved_tokens`
- `verified_saved_tokens`
- `full_reads_avoided`
- `escalations_required`
- `net_savings_after_escalation`

### Likely Code Touchpoints

- [src/core/session-analytics.ts](/home/shahinyanm/www/token-pilot/src/core/session-analytics.ts)

### Success Criteria

- lower skepticism about savings
- clearer weak-tool detection

### Priority

`P1`

## Track 10: Team Policy Mode

### Why

Long-term savings should not depend only on an individual user's discipline.

### Hypothesis

A configurable policy layer will make token savings reproducible across teams.

### Proposed Policies

- cheap-first reads only
- full read requires escalation trigger
- edit workflows must use `read_for_edit` first
- project overviews cached per session

### Likely Code Touchpoints

- config loading
- [src/server.ts](/home/shahinyanm/www/token-pilot/src/server.ts)

### Success Criteria

- more consistent savings across users
- easier enterprise positioning

### Priority

`P2`

## Delivery Plan

## Phase 1: Low-Risk, High-ROI

Duration: `1-2 weeks`

- Track 0: Instrumentation First
- Track 1: Context Budget Planner in shadow mode
- Track 2: Intent Router for a small set of intents
- Track 3: Edit Prep Mode MVP

Expected outcome:

- measurable savings improvement with minimal product risk

## Phase 2: Compounding Efficiency

Duration: `2-4 weeks`

- Track 4: Semantic Context Cache
- Track 5: Confidence-Based Escalation
- Track 6: Task-Scoped Working Set
- Track 7: Related Files Ranking

Expected outcome:

- lower repeated read cost
- fewer wasteful expansions in multi-step tasks

## Phase 3: Durable Product Advantage

Duration: `4-8 weeks`

- Track 8: Architecture Fingerprint
- Track 9: Verified Savings Analytics
- Track 10: Team Policy Mode

Expected outcome:

- stronger trust
- better enterprise narrative
- better repeatability of savings

## Suggested Experiments

## Experiment A: Planner Shadow Mode

Run planner without changing behavior for one release cycle.

Measure:

- how often planner would choose a cheaper path
- how often current routing already matches optimal choice

## Experiment B: Edit Prep Default

Force edit-intent tasks through `read_for_edit` first for a sample group.

Measure:

- token reduction
- patch acceptance
- reread frequency

## Experiment C: Cached Overview

Cache project-level and module-level summaries in-session.

Measure:

- repeated overview cost reduction
- stale-context incidents

## Experiment D: Ranked Related Files

Return only top `3` related files by default, with overflow available on demand.

Measure:

- average follow-up reads
- user success in debugging and navigation tasks

## Anti-Goals

These changes should be rejected even if they improve savings superficially.

- aggressive compression that drops code facts needed for edits
- forcing summaries where exact raw code is required
- hiding escalation costs inside analytics
- optimizing benchmark sessions while harming real developer flows

## What To Build First

If only three things are implemented, build these first:

1. `Context Budget Planner`
2. `Edit Prep Mode`
3. `Verified Savings Analytics`

Reason:

- they improve real economics fastest
- they are easiest to explain in product terms
- they create a stronger foundation for all later routing work

## Expected Business Impact

If executed well, these tracks should move the product from:

- useful token-saving helper

to:

- trusted routing layer for code-reading cost control

That is the difference between a clever tool and a real product category.
