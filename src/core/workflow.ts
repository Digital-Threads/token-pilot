/**
 * v0.38.0 — fleet workflow lifecycle.
 *
 * The fleet design note (docs/design/2026-06-tp-fleet-dynamic-workflows.md)
 * flagged one blocker: it assumed Claude Code's `/workflow` would set a
 * propagated workflow-id env var on dispatched subagents. The 2.1.131
 * bundle has no such variable, so building tagging/budget against it
 * would be the v0.34.0-args mistake again (shipping against an
 * interface that may not exist).
 *
 * Resolution: token-pilot OWNS the workflow boundary. A user wraps a
 * batch of fan-out work with `token-pilot workflow start` / `end`,
 * which writes an envelope file and exports `TOKEN_PILOT_WORKFLOW_ID`.
 * Every hook reads that env var and tags its events. No dependency on
 * Claude Code's `/workflow` — and if CC ever propagates its own
 * workflow id env var, we read that too (see activeWorkflowId).
 *
 * State lives in `<projectRoot>/.token-pilot/workflows/`:
 *   <id>.json                 — the envelope (goal, budget, started/ended)
 * Events stay in the normal hook-events.jsonl, tagged with workflow_id.
 *
 * Pure-ish: all filesystem helpers swallow errors (telemetry must
 * never break a hook). The `now`/`id` injection points keep the unit
 * tests deterministic.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  loadEventsTree,
  type HookEvent,
} from "./event-log.js";

export const WORKFLOW_SUBDIR = ".token-pilot/workflows";

export interface WorkflowEnvelope {
  workflow_id: string;
  started_at: number;
  ended_at: number | null;
  goal: string;
  budget_tokens: number | null;
  max_parallel: number | null;
}

export interface WorkflowBudgetStatus {
  workflow_id: string;
  goal: string;
  budget_tokens: number | null;
  used_tokens: number;
  pct: number | null;
  event_count: number;
  task_count: number;
  over_budget_workers: number;
  ended: boolean;
}

// ─── env access ──────────────────────────────────────────────────────

/**
 * Resolve the active workflow id. token-pilot's own env var takes
 * precedence; we also honour a couple of plausible Claude Code names
 * so that if CC ever propagates a workflow id we pick it up without
 * a code change. Returns null when none is set.
 */
export function activeWorkflowId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    env.TOKEN_PILOT_WORKFLOW_ID ||
    env.CLAUDE_CODE_WORKFLOW_ID ||
    env.CLAUDE_WORKFLOW_ID ||
    null
  );
}

// ─── id generation ───────────────────────────────────────────────────

/**
 * Build a workflow id. Format `wf-<base36 ts>-<suffix>`. `now` and
 * `suffix` are injectable for deterministic tests; production passes a
 * timestamp + a short random token.
 */
export function makeWorkflowId(now: number, suffix: string): string {
  return `wf-${now.toString(36)}-${suffix}`;
}

// ─── paths ───────────────────────────────────────────────────────────

function workflowDir(projectRoot: string): string {
  return join(projectRoot, WORKFLOW_SUBDIR);
}
function envelopePath(projectRoot: string, id: string): string {
  return join(workflowDir(projectRoot), `${id}.json`);
}

// ─── lifecycle ───────────────────────────────────────────────────────

export interface StartWorkflowInput {
  projectRoot: string;
  goal: string;
  budgetTokens?: number | null;
  maxParallel?: number | null;
  /** Injectable for tests. */
  now?: number;
  /** Injectable for tests. */
  idSuffix?: string;
}

/**
 * Create a workflow envelope and return it. The caller is responsible
 * for exporting `TOKEN_PILOT_WORKFLOW_ID=<id>` into the environment of
 * the work that follows (the CLI prints an `export` line for this).
 */
export async function startWorkflow(
  input: StartWorkflowInput,
): Promise<WorkflowEnvelope> {
  const now = input.now ?? Date.now();
  const suffix =
    input.idSuffix ?? Math.floor(now % 1_000_000).toString(36).padStart(4, "0");
  const envelope: WorkflowEnvelope = {
    workflow_id: makeWorkflowId(now, suffix),
    started_at: now,
    ended_at: null,
    goal: input.goal,
    budget_tokens: input.budgetTokens ?? null,
    max_parallel: input.maxParallel ?? null,
  };
  try {
    await fs.mkdir(workflowDir(input.projectRoot), { recursive: true });
    await fs.writeFile(
      envelopePath(input.projectRoot, envelope.workflow_id),
      JSON.stringify(envelope, null, 2) + "\n",
    );
  } catch {
    /* best-effort — never block the caller */
  }
  return envelope;
}

export async function loadWorkflow(
  projectRoot: string,
  id: string,
): Promise<WorkflowEnvelope | null> {
  try {
    const raw = await fs.readFile(envelopePath(projectRoot, id), "utf-8");
    const parsed = JSON.parse(raw) as WorkflowEnvelope;
    if (parsed && typeof parsed.workflow_id === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Mark a workflow ended (stamps ended_at) and emit a frozen
 * `event:"workflow"` completion record into hook-events.jsonl.
 *
 * v0.39.0 — the envelope stores only the static plan (goal, budget,
 * timestamps); the aggregates (tokens used, task count) are computed
 * live from tagged events. Freezing them in a single summary row at
 * end time makes historical analysis cheap and survives event-log
 * rotation (which could otherwise drop the underlying per-task rows).
 * Returns the updated envelope, or null when the id is unknown.
 */
export async function endWorkflow(
  projectRoot: string,
  id: string,
  now: number = Date.now(),
): Promise<WorkflowEnvelope | null> {
  const env = await loadWorkflow(projectRoot, id);
  if (!env) return null;
  env.ended_at = now;
  try {
    await fs.writeFile(
      envelopePath(projectRoot, id),
      JSON.stringify(env, null, 2) + "\n",
    );
  } catch {
    /* best-effort */
  }

  // Freeze the aggregates into a completion event.
  try {
    const events = await loadEventsTree(projectRoot);
    const status = computeWorkflowStatus(env, events);
    const summary: HookEvent = {
      ts: now,
      session_id: "workflow",
      agent_type: null,
      agent_id: null,
      workflow_id: id,
      event: "workflow",
      file: "",
      lines: 0,
      estTokens: status.used_tokens,
      summaryTokens: 0,
      savedTokens: 0,
      level: "info",
      code: "workflow_complete",
      detail: {
        goal: env.goal,
        budget_tokens: env.budget_tokens,
        used_tokens: status.used_tokens,
        pct: status.pct,
        task_count: status.task_count,
        over_budget_workers: status.over_budget_workers,
        duration_ms: env.ended_at - env.started_at,
      },
    };
    // Pass the workflow_id explicitly so appendEvent keeps it even if
    // the env var has already been unset by the time `end` runs.
    await appendEvent(projectRoot, summary);
  } catch {
    /* completion telemetry is best-effort */
  }
  return env;
}

/** List all workflow envelopes, newest first. */
export async function listWorkflows(
  projectRoot: string,
): Promise<WorkflowEnvelope[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(workflowDir(projectRoot));
  } catch {
    return [];
  }
  const out: WorkflowEnvelope[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const env = await loadWorkflow(projectRoot, name.replace(/\.json$/, ""));
    if (env) out.push(env);
  }
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}

// ─── budget + telemetry ──────────────────────────────────────────────

/**
 * Pure aggregation of a workflow's status from its envelope + the set
 * of events tagged with its id. Separated from I/O so tests drive it
 * directly.
 */
export function computeWorkflowStatus(
  envelope: WorkflowEnvelope,
  events: HookEvent[],
): WorkflowBudgetStatus {
  const mine = events.filter((e) => e.workflow_id === envelope.workflow_id);
  let used = 0;
  let taskCount = 0;
  let overWorkers = 0;
  for (const e of mine) {
    if (e.event === "task") {
      taskCount++;
      used += e.estTokens || 0;
      if (e.overBudget) overWorkers++;
    }
  }
  const pct =
    envelope.budget_tokens && envelope.budget_tokens > 0
      ? Math.round((used / envelope.budget_tokens) * 100)
      : null;
  return {
    workflow_id: envelope.workflow_id,
    goal: envelope.goal,
    budget_tokens: envelope.budget_tokens,
    used_tokens: used,
    pct,
    event_count: mine.length,
    task_count: taskCount,
    over_budget_workers: overWorkers,
    ended: envelope.ended_at != null,
  };
}

/**
 * Load a workflow's live status from disk (envelope + tagged events
 * across the repo tree). Returns null when the id is unknown.
 */
export async function workflowStatus(
  projectRoot: string,
  id: string,
): Promise<WorkflowBudgetStatus | null> {
  const envelope = await loadWorkflow(projectRoot, id);
  if (!envelope) return null;
  const events = await loadEventsTree(projectRoot);
  return computeWorkflowStatus(envelope, events);
}

/**
 * Returns true when the workflow's used tokens are within `nearPct`
 * percent of its ceiling (or over). Used by the pre-task hook to warn
 * the fleet to wind down before the ceiling is breached. False when no
 * budget is set.
 */
export function isWorkflowNearBudget(
  status: WorkflowBudgetStatus,
  nearPct = 90,
): boolean {
  if (status.budget_tokens == null || status.budget_tokens <= 0) return false;
  return status.used_tokens >= status.budget_tokens * (nearPct / 100);
}

// ─── formatting ──────────────────────────────────────────────────────

function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export function formatWorkflowStatus(status: WorkflowBudgetStatus): string {
  const lines: string[] = [];
  lines.push(
    `workflow ${status.workflow_id}${status.ended ? " (ended)" : ""}`,
  );
  lines.push(`  goal:        ${status.goal}`);
  const budget =
    status.budget_tokens != null
      ? `${humanTokens(status.budget_tokens)} ceiling`
      : "no ceiling";
  const pct = status.pct != null ? ` (${status.pct}%)` : "";
  lines.push(
    `  budget:      ${budget} · ${humanTokens(status.used_tokens)} used${pct}`,
  );
  lines.push(
    `  tasks:       ${status.task_count} dispatched · ${status.over_budget_workers} over-budget`,
  );
  lines.push(`  events:      ${status.event_count} tagged`);
  return lines.join("\n");
}

export function formatWorkflowList(workflows: WorkflowEnvelope[]): string {
  if (workflows.length === 0) return "No workflows recorded.";
  const lines: string[] = [`${workflows.length} workflow(s):`];
  for (const w of workflows) {
    const state = w.ended_at ? "ended " : "active";
    const budget =
      w.budget_tokens != null ? `${humanTokens(w.budget_tokens)} ceiling` : "—";
    lines.push(`  [${state}] ${w.workflow_id}  ${budget}  ${w.goal}`);
  }
  return lines.join("\n");
}
