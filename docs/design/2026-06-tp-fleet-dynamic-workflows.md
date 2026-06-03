# tp-* fleet × dynamic workflows — design note

**Status:** exploration / not scheduled
**Date:** 2026-06
**Linked CC release:** 2.1.154 (introduced `/workflow` + dynamic workflows)
**Linked plugin release:** v0.36.0 (groundwork — sessionTitle, disallowed-tools)
**Author:** token-pilot team

## What changed in Claude Code

Claude Code 2.1.154 shipped **dynamic workflows**: the `/workflow`
command can orchestrate "tens to hundreds of agents" in the
background, dispatched in waves, with results merged back into a
single foreground session. The interesting bit is that the dispatched
agents can be **any** registered subagent — including our 25 `tp-*`
specialists.

That changes the unit of work we ship from "one user → one agent
turn" to "one workflow → many fan-out tp-* invocations". The design
question is what token-pilot should expose to make that fleet
behave like a coherent system rather than 25 disconnected workers.

## Today's gaps (why this is more than just "it works")

When the user runs `/workflow review every PR touched in the last
sprint`, Claude Code might dispatch:

- 25× `tp-pr-reviewer` waves (one per PR)
- 10× `tp-history-explorer` (sub-questions raised by the review)
- 5× `tp-test-coverage-gapper` (PRs that touched untested paths)
- 5× `tp-impact-analyzer` (PRs that touched shared symbols)

Each runs in its own subprocess with its own MCP server connection.
Each writes events to its own `agent_id` row in
`hook-events.jsonl`. Right now there is **no fleet-level state**:

1. **No shared memory.** v0.35.0 gave us `memory: project` per
   agent. But two `tp-pr-reviewer` workers don't share the same
   memory file mid-workflow — one might re-discover a finding the
   other already booked.

2. **No coalesced telemetry.** `stats --tasks` aggregates after the
   fact; during a 100-agent workflow the user has no visible
   progress bar that says "fleet saved X, blocked Y, deferred Z".

3. **No per-workflow budget.** We have `session_budget` per single
   session. A workflow has many sessions. Nobody owns "this entire
   `/workflow` invocation must stay under N tokens".

4. **No fleet-level dedup.** If three workers all run `find_usages`
   for the same symbol within seconds, ast-index honestly computes
   the answer three times. We could memoise across the fleet.

5. **No workflow-aware session title.** We surface `[TP] Nk saved`
   per session — but during a workflow the user actually wants
   `[TP] workflow 17/100 · 4.2M saved`. Same field, richer payload.

## Proposed primitives (v0.37 → v0.38 territory)

### 1. Workflow context envelope

A small JSON file at
`<project>/.token-pilot/workflows/<workflow_id>.json` written by the
foreground session before the fan-out starts:

```jsonc
{
  "workflow_id": "wf-2026-06-abc123",
  "started_at": 1717200000000,
  "goal": "review PRs from last sprint",
  "budget_tokens": 2_000_000,
  "max_parallel": 16,
  "tp_agent_quota": { "tp-pr-reviewer": 25, "tp-test-coverage-gapper": 5 }
}
```

Every dispatched subagent reads it on startup via env var
`TOKEN_PILOT_WORKFLOW_ID`. The hook layer attaches the workflow ID
to every event in `hook-events.jsonl`.

**Why a file, not in-memory:** worker processes are short-lived and
isolated. A file is the cheapest shared substrate that survives
process death.

### 2. Per-workflow budget accounting

Extend `session_budget` MCP tool to accept an optional
`workflow_id` filter. New CLI:

```sh
token-pilot workflow-budget wf-2026-06-abc123
# → 2.0M ceiling · 1.4M used (70 %) · 3 over-budget workers
```

Hook layer increments a per-workflow counter; when the ceiling is
within 10 %, the next `PreToolUse:Task` returns a deny with a
specific message: "workflow ceiling almost hit — finish in-flight
work and report".

### 3. Fleet-level memory rendezvous

Today `memory: project` is one file per agent type per project.
For a workflow we want:

```
.token-pilot/memory/
  wf-2026-06-abc123/
    tp-pr-reviewer.shared.json    # appended-to by every worker
    tp-history-explorer.shared.json
```

Workers read on startup, append on finish. The reconciliation is
last-write-wins on JSON keys plus an append-only log of `findings`.
Simple, race-tolerant, no DB.

### 4. ast-index memoisation cache

ast-index already caches per-query inside one process. We add a
shared SQLite (or just a JSON cache) at
`.token-pilot/cache/ast-index/<repo-fingerprint>.json` keyed by
`(operation, symbol, repo HEAD sha)`. Workers consult before
spawning the binary.

Risk: cache invalidation. Use repo HEAD sha as a hard key — when
HEAD moves, cache is silently abandoned. Cheap.

### 5. Workflow-aware sessionTitle

Extend the v0.36.0 sessionTitle path. When `TOKEN_PILOT_WORKFLOW_ID`
is set, title becomes:

```
[TP] wf-abc · 17/100 · 4.2M saved
```

Foreground session reads the workflow context envelope and shows
the live counter. Sub-workers don't set sessionTitle (only the
foreground).

### 6. Workflow completion hook

New CC event (not yet shipped — would need Anthropic to add):
`WorkflowComplete`. On fire, our handler emits a single
`event: "workflow"` row to `hook-events.jsonl` summarising the run.
Until CC adds the event, we can polyfill via watching the workflow
context envelope's mtime + a debounce.

## Non-goals

- **Reimplement workflow orchestration.** Claude Code owns `/workflow`.
  We attach state, not orchestration.
- **Replace `memory: project`.** Per-agent project memory still
  works outside workflows. Workflow memory is additive scope.
- **Persist workflows across machines.** Files stay project-local.
  Cross-machine sync is out of scope.

## Sequencing

| Phase | Trigger | Scope |
|-------|---------|-------|
| **Phase 0** (now, v0.36.0) | groundwork | sessionTitle + disallowed-tools + design doc |
| **Phase 1** (v0.37) | first user reports a workflow run | workflow envelope + workflow_id on every event + workflow-budget CLI |
| **Phase 2** (v0.38) | aggregate data shows fleet dedup misses | shared ast-index cache + fleet memory directory |
| **Phase 3** (v0.39) | CC adds `WorkflowComplete` OR community asks for it | workflow-complete event + completion telemetry |

Each phase ships only when there's a real-world signal — no
speculative building. v0.35.0 already demonstrated the failure mode
of building on undocumented features without data backing.

## Open questions

- Does `/workflow` set an env var Claude Code propagates to
  dispatched subagents? If not, we need a different rendezvous.
- How does Claude Code surface workflow progress to the user today?
  If it owns a progress display, our sessionTitle augmentation
  competes; we should defer to CC's UI when present.
- What's the latency of a fresh ast-index query on a 50k-symbol
  repo? Decides whether step 4 (shared cache) is worth the
  complexity. Hypothesis: under 50 ms per query → cache not worth
  it; over 500 ms → mandatory.

## Decision (updated v0.38.0)

**Implemented in v0.38.0 — with the dependency inverted.**

The original blocker was "does `/workflow` propagate a workflow-id
env var?" Inspecting the installed Claude Code 2.1.131 bundle
confirmed it does NOT (no `/workflow`, no workflow-id variable).
Rather than build against an interface that may never exist, we
inverted the dependency: **token-pilot owns the workflow boundary.**
`token-pilot workflow start/end` writes the envelope and sets
`TOKEN_PILOT_WORKFLOW_ID` itself, so the feature works under any
orchestration (Claude Code `/workflow`, the Agent tool, or a shell
loop) and composes with CC's `/workflow` if it ever sets
`CLAUDE_CODE_WORKFLOW_ID` (which `activeWorkflowId()` already reads).

Shipped:

- **Workflow envelope** — `.token-pilot/workflows/<id>.json`
  (`src/core/workflow.ts`).
- **Event tagging** — `HookEvent.workflow_id`; `appendEvent`
  auto-tags from the env var so every existing call site participates
  with no change.
- **Budget accounting** — `computeWorkflowStatus` /
  `workflowStatus`; `token-pilot workflow status` shows
  ceiling/used/%/task-count/over-budget-workers.
- **Budget guard** — PreToolUse:Task appends a wind-down note + logs
  `workflow_near_budget` at ≥90 % (advisory, never a hard block).
- **Workflow-aware sessionTitle** — `[TP] wf · N tasks · X%`.
- **CLI** — `workflow start|end|status|list`.

Deliberately NOT built (still gated on real signal):

- **Fleet memory rendezvous** (shared per-workflow agent memory) and
  the **ast-index memoisation cache** — the server-side `SessionCache`
  already dedups MCP reads within a process, and we have no data yet
  showing cross-worker duplicate work is a measurable cost. Revisit
  when a real fan-out run produces that data.
- **`WorkflowComplete` hook polyfill** — wait for the first user to
  run a large workflow and tell us what summary they want.

This keeps the v0.34.x / v0.35.x discipline: build against interfaces
we can verify (here, one we own), defer the rest until data justifies
it.
