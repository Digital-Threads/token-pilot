/**
 * v0.40.0 — SubagentStop task-completion capture.
 *
 * Why this exists (grounded, not speculative):
 *
 * PostToolUse:Task was supposed to record one `event:"task"` per
 * subagent dispatch. A clean restarted-session probe on v0.39.3
 * proved it does not fire: a real subagent dispatch produced ZERO
 * events, while a Read-deny in the SAME session wrote its `denied`
 * event fine (so appendEvent + the hook runtime are healthy). That
 * is years of "0 task events" explained — the parent-side PostToolUse
 * hook simply never lands for the dispatch tool on this Claude Code.
 *
 * SubagentStop is Claude Code's canonical subagent-completion event
 * (confirmed in the 2.1.131/2.1.161 bundle schema:
 *   literal("SubagentStop"), stop_hook_active, agent_id,
 *   agent_transcript_path, agent_type, last_assistant_message ).
 * It fires once per subagent completion by definition, so it is the
 * reliable place to record the adoption signal the whole v0.30 goal
 * depends on: WAS a subagent used, and was it a tp-* or not.
 *
 * Tokens: SubagentStop carries `agent_transcript_path`. We make a
 * best-effort read of the transcript's cumulative usage; on any
 * failure we record estTokens:0 — the agent_type signal is the
 * primary value, tokens are secondary.
 *
 * Routing-miss detection (was general-purpose picked where a tp-*
 * fit?) stays in the PreToolUse:Task diagnostic, which has the task
 * description SubagentStop lacks. This hook records the ACTUAL
 * completion; pre-task records the ADVICE.
 */

import { readFileSync } from "node:fs";
import type { HookEvent } from "../core/event-log.js";
import { estimateTokens } from "../core/token-estimator.js";
import { bareAgentName } from "../core/agent-matcher.js";
import {
  parseAgentBudget,
  decideBudgetAdvice,
  appendOverBudgetLog,
  loadAgentBody,
} from "./post-task.js";

export interface SubagentStopInput {
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  session_id?: string;
  parent_agent_id?: string;
  /**
   * v0.45.0 — root/parent session id. CC ships this in the SubagentStop
   * payload (`X.parent_session_id`). Lets the statusline roll a subagent's
   * savings (tagged with the agent's own session id) up to the parent
   * conversation. Absent on older CC → field simply not written.
   */
  parent_session_id?: string;
}

/**
 * Best-effort output-token total from a subagent transcript (JSONL of CC
 * messages). Returns 0 on any read/parse failure — never throws.
 *
 * This is the *output* axis only, which is the one the tp-* agents are
 * measured on ("Response budget: ~N tokens"). It is not a cost figure:
 * input and cache-read tokens dominate real usage by two orders of
 * magnitude and are deliberately not counted here.
 *
 * Note for anyone extending this: Claude Code writes one record per
 * content block (thinking / text / tool_use) and repeats the same usage
 * object on each, so summing a field across lines double-counts within a
 * request. That costs ~1.4% on `output_tokens` (blocks carry differing
 * values) but would be a clean ~2x error on any input-side field — group
 * by `requestId` first if you add one.
 *
 * The `usage.total_tokens` fallback below never fired on six real
 * transcripts sampled in July 2026 — none carried that field. Kept
 * anyway: it costs nothing and older or future CC builds may emit it.
 */
export function tokensFromTranscript(path: string | undefined): number {
  if (!path || typeof path !== "string") return 0;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }
  let out = 0;
  let lastTotal = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (rec as { message?: { usage?: Record<string, unknown> } })
      .message;
    const usage =
      msg?.usage ?? (rec as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const o = usage.output_tokens;
      if (typeof o === "number") out += o;
      const t = usage.total_tokens;
      if (typeof t === "number") lastTotal = t;
    }
  }
  // Prefer summed output tokens; fall back to the last cumulative total.
  return out > 0 ? out : lastTotal;
}

/**
 * Size of the subagent's FINAL reply, in tokens.
 *
 * Distinct from `tokensFromTranscript`, which sums everything the agent
 * ever emitted. The tp-* agents declare "Response budget: ~N tokens",
 * and that budget is about the answer handed back to the caller — not
 * about the thinking and tool calls along the way.
 *
 * Claude Code 2.1.271 moved that answer into a `SubagentHandback` tool
 * call, leaving a stub like "Handing back." as the last text block.
 * Measured on a real run: a 5 KB report scored 4 tokens, so the watchdog
 * could never fire. The handback message is the reply when present; the
 * last text turn stays as the fallback for older builds.
 *
 * The SubagentStop payload also has a `last_assistant_message` field
 * (present in the 2.1.220 bundle), but nothing in this codebase has ever
 * read it, so we have no evidence it is populated. The transcript is the
 * source we already rely on, so it stays the single source here.
 *
 * Returns 0 when the path is missing, unreadable, or the agent finished
 * without a text reply — never throws.
 */
export function finalResponseTokens(path: string | undefined): number {
  if (!path || typeof path !== "string") return 0;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }
  let lastText = "";
  let handback = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (
      rec as {
        message?: { role?: string; content?: unknown };
      }
    ).message;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("");
    if (text.trim()) lastText = text;

    for (const block of msg.content) {
      if (
        typeof block !== "object" ||
        block === null ||
        (block as { type?: unknown }).type !== "tool_use" ||
        (block as { name?: unknown }).name !== "SubagentHandback"
      ) {
        continue;
      }
      const sent = (block as { input?: { message?: unknown } }).input?.message;
      if (typeof sent === "string" && sent.trim()) handback = sent;
    }
  }

  const reply = handback || lastText;
  return reply ? estimateTokens(reply) : 0;
}

/**
 * Response-budget watchdog for tp-* subagents.
 *
 * Lived in PostToolUse:Task since v0.37.0, but that hook does not fire
 * for the dispatch tool on current Claude Code — so the check never ran,
 * `over-budget.log` never appeared, and every recorded task event carried
 * a null budget. SubagentStop is where completions actually arrive.
 *
 * Returns an advisory string when the reply overran the declared budget,
 * or null in every other case (non-tp agent, no budget declared, agent
 * file missing, transcript unreadable). Never throws: a watchdog must not
 * be able to break subagent completion.
 */
export async function checkSubagentBudget(
  projectRoot: string,
  homeDir: string,
  input: Pick<SubagentStopInput, "agent_type" | "agent_transcript_path">,
): Promise<string | null> {
  try {
    const agent = input.agent_type;
    if (typeof agent !== "string" || !bareAgentName(agent).startsWith("tp-"))
      return null;

    const actualTokens = finalResponseTokens(input.agent_transcript_path);
    if (actualTokens <= 0) return null;

    const body = await loadAgentBody(projectRoot, homeDir, agent);
    const budget = body ? parseAgentBudget(body) : null;
    if (budget == null) return null;

    const decision = decideBudgetAdvice({
      agentName: agent,
      budget,
      actualTokens,
    });
    if (!decision.overBudget) return null;

    await appendOverBudgetLog(projectRoot, {
      ts: Date.now(),
      agent,
      budget,
      actualTokens,
      overByRatio: decision.overByRatio,
    });
    return decision.message;
  } catch {
    return null;
  }
}

/**
 * Build the `event:"task"` record from a SubagentStop payload. Pure —
 * no I/O except the optional transcript token read, which the caller
 * can pre-resolve for tests via `tokensOverride`.
 */
export function buildSubagentTaskEvent(
  input: SubagentStopInput,
  now: number,
  tokensOverride?: number,
): HookEvent | null {
  const agentType =
    typeof input.agent_type === "string" ? input.agent_type : "";
  // No agent_type → nothing meaningful to record.
  if (!agentType) return null;

  const est =
  tokensOverride ??
    // The summed output total went unusable in Claude Code 2.1.271: the
    // records carrying `usage` are the server-side classifier's, so a run
    // that cost 117k tokens sums to 199. The reply size is the one figure
    // still measurable on both old and new builds, so take whichever is
    // larger rather than reporting two orders of magnitude too little.
    Math.max(
      tokensFromTranscript(input.agent_transcript_path),
      finalResponseTokens(input.agent_transcript_path),
    );

  return {
    ts: now,
    session_id: input.session_id ?? "",
    agent_type: input.agent_type ?? null,
    agent_id: input.agent_id ?? null,
    ...(input.parent_agent_id ? { parent_agent_id: input.parent_agent_id } : {}),
    ...(input.parent_session_id
      ? { parent_session_id: input.parent_session_id }
      : {}),
    event: "task",
    file: "",
    lines: 0,
    estTokens: est,
    summaryTokens: 0,
    savedTokens: 0,
    subagent_type: agentType,
    // SubagentStop has no task description, so no heuristic match here.
    // Routing-miss detection lives in the PreToolUse:Task diagnostic.
    matched_tp_agent: null,
    // Mark the source so a future revival of PostToolUse:Task can be
    // deduped in stats rather than double-counted.
    code: "subagent_stop",
  };
}

// ─── v0.41.0 SubagentStop feedback ───────────────────────────────────

export interface SubagentFeedbackContext {
  /** Active workflow budget status, when a fleet workflow is running. */
  workflow?: {
    workflow_id: string;
    budget_tokens: number | null;
    used_tokens: number;
    pct: number | null;
  } | null;
}

/**
 * Decide the `additionalContext` feedback to hand back from a
 * SubagentStop hook. Pure — caller resolves the workflow status.
 *
 * Returns a short wind-down note when an active fleet workflow is at or
 * past 90 % of its token ceiling, so a `/workflow`-style fan-out winds
 * down before the budget is blown. Returns null otherwise — we do NOT
 * nag on every completion; broad adoption nudges stay in SessionStart.
 *
 * Emission is the caller's responsibility and is gated behind
 * TOKEN_PILOT_SUBAGENT_FEEDBACK=1 + Claude Code 2.1.163+ (older Claude
 * Code labels a SubagentStop hookSpecificOutput return as a hook error).
 */
export function decideSubagentFeedback(
  _input: SubagentStopInput,
  ctx: SubagentFeedbackContext,
): string | null {
  const wf = ctx.workflow;
  if (
    wf &&
    wf.budget_tokens != null &&
    wf.budget_tokens > 0 &&
    wf.used_tokens >= wf.budget_tokens * 0.9
  ) {
    const pct = wf.pct != null ? `${wf.pct}%` : "~90%";
    return (
      `[token-pilot] workflow ${wf.workflow_id} is at ${pct} of its ` +
      `${wf.budget_tokens} token ceiling (${wf.used_tokens} used). ` +
      `Wind down the fan-out: finish in-flight branches and report ` +
      `rather than dispatching new agents.`
    );
  }
  return null;
}

/**
 * Render the SubagentStop hook JSON response carrying feedback. Returns
 * null when there is nothing to say (caller writes no stdout).
 */
export function renderSubagentFeedback(message: string | null): string | null {
  if (!message) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      additionalContext: message,
    },
  });
}
