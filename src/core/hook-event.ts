/**
 * Builders for hook-events.jsonl records. No Node here: the CLI hooks
 * (core/event-log.ts) and the Claude Code mod write the same lines.
 */

import type { HookEvent } from "./event-log.js";

export interface DiagnosticArgs {
  code: string;
  level?: "info" | "warn" | "error";
  detail?: Record<string, unknown>;
  sessionId?: string;
  agentType?: string | null;
  agentId?: string | null;
  durationMs?: number;
}

export function diagnosticEvent(args: DiagnosticArgs, now: number): HookEvent {
  return {
    ts: now,
    session_id: args.sessionId ?? "diagnostic",
    agent_type: args.agentType ?? null,
    agent_id: args.agentId ?? null,
    event: "diagnostic",
    file: "",
    lines: 0,
    estTokens: 0,
    summaryTokens: 0,
    savedTokens: 0,
    level: args.level ?? "info",
    code: args.code,
    detail: args.detail,
    duration_ms: args.durationMs,
  };
}

/**
 * v0.38.0 — tag the active workflow id so every event emitted inside a
 * `token-pilot workflow` boundary is sliceable; Loom's task id likewise. An
 * id already on the event wins.
 */
export function tagEvent(
  event: HookEvent,
  env: Readonly<Record<string, string | undefined>>,
): HookEvent {
  const workflowId =
    event.workflow_id ??
    env.TOKEN_PILOT_WORKFLOW_ID ??
    env.CLAUDE_CODE_WORKFLOW_ID ??
    env.LOOM_WORKFLOW_ID ??
    undefined;
  const taskId = event.task_id ?? env.LOOM_TASK_ID ?? undefined;

  let tagged = event;
  if (workflowId) tagged = { ...tagged, workflow_id: workflowId };
  if (taskId) tagged = { ...tagged, task_id: taskId };

  return tagged;
}

/** Size at which hook-events.jsonl is archived before the next append. */
export const ROTATION_THRESHOLD_BYTES = 10_000_000;

export function shouldRotate(
  stat: { size: number },
  thresholdBytes: number = ROTATION_THRESHOLD_BYTES,
): boolean {
  return stat.size >= thresholdBytes;
}
