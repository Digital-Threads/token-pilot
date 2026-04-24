/**
 * v0.31.0 Pack 2 — PreToolUse:Task routing enforcement.
 *
 * Pack 1 (already shipped) built the matcher and telemetry. Pack 2 acts
 * on that matcher: BEFORE a Task dispatch fires, we inspect
 * `tool_input.subagent_type` + `tool_input.description`, heuristically
 * match against the shipped `tp-*` catalog, and redirect (advise / deny)
 * general-purpose calls that clearly fit a specialised agent.
 *
 * Why not straight-deny:
 *   - The pre-edit rollback in v0.30.4 taught us the cost of a false
 *     hard-block (stuck sessions, BYPASS env creep). Task routing has
 *     MORE ambiguity than Edit (descriptions are terse; recall on
 *     keyword match is imperfect), so the default mode = advise.
 *
 * Tier logic (first match wins):
 *
 *   1. tool_name !== "Task"                          → allow
 *   2. subagent_type ∈ tp-*                          → allow
 *   3. description contains an ESCAPE phrase         → allow
 *      (ad-hoc / research / explore / multi-step / across the codebase)
 *   4. matchTpAgent returns null                     → allow
 *   5. TOKEN_PILOT_FORCE_SUBAGENTS=1 OR mode=strict  → deny
 *      (hard-block: agent author opted into pedantic routing)
 *   6. confidence=high                               → advise
 *   7. confidence=low                                → advise (softer msg)
 *
 * Pure decide — all context (agent index, env, mode) is pre-resolved
 * by the caller so the function stays deterministic and unit-testable.
 */

import type { EnforcementMode } from "../server/enforcement-mode.js";
import type { AgentIndex } from "../core/agent-matcher.js";
import { matchTpAgent } from "../core/agent-matcher.js";

export interface PreTaskInput {
  tool_name?: string;
  tool_input?: {
    subagent_type?: string;
    description?: string;
    [k: string]: unknown;
  };
}

export type PreTaskDecision =
  | { kind: "allow" }
  | { kind: "advise"; message: string }
  | { kind: "deny"; reason: string };

export interface PreTaskContext {
  /** Parsed enforcement mode. `strict` is the only hard-block tier. */
  mode: EnforcementMode;
  /** Agent catalog built at startup by buildAgentIndex. */
  agentIndex: AgentIndex;
  /** TOKEN_PILOT_FORCE_SUBAGENTS=1 — opt-in strictness regardless of mode. */
  force: boolean;
}

/**
 * Escape phrases that tell us the user genuinely wants open-ended
 * general-purpose work. Short list of boilerplate — keeping it tight
 * prevents the escape from eating otherwise-valid routing.
 *
 * All checks are lowercased substring matches. Author new entries here
 * only when tool-audit shows a legitimate pattern getting false-flagged.
 */
const ESCAPE_PHRASES = [
  "ad-hoc",
  "ad hoc",
  "one-off",
  "one off",
  "open-ended",
  "research across",
  "explore multiple",
  "multi-step",
  "across the codebase",
  "across the repo",
  "general purpose",
];

function containsEscape(description: string): boolean {
  const n = description.toLowerCase();
  return ESCAPE_PHRASES.some((p) => n.includes(p));
}

/**
 * Pure decision function. Caller resolves all context (env, mode,
 * agent index) up front so this stays a plain input → output mapping.
 */
export function decidePreTask(
  input: PreTaskInput,
  ctx: PreTaskContext,
): PreTaskDecision {
  if (input.tool_name !== "Task") return { kind: "allow" };

  const subagentType = input.tool_input?.subagent_type ?? "";
  const description = input.tool_input?.description ?? "";

  // Already a tp-* — routing intent matches catalog. Let it run.
  if (typeof subagentType === "string" && subagentType.startsWith("tp-")) {
    return { kind: "allow" };
  }

  // No description → nothing to match against. Allow (Claude Code
  // sometimes dispatches Task with only a subagent_type + session id).
  if (!description || description.length === 0) return { kind: "allow" };

  // Author-blessed escape clauses — user is explicitly saying
  // "this is broad". Respect that.
  if (containsEscape(description)) return { kind: "allow" };

  const hit = matchTpAgent(description, ctx.agentIndex);
  if (!hit) return { kind: "allow" };

  const suggestion =
    `Consider dispatching \`${hit.agent}\` instead of \`${subagentType || "general-purpose"}\` — ` +
    `the description matches its trigger phrases (confidence: ${hit.confidence}). ` +
    `tp-* agents run under a tighter budget and output in terse style, typically ` +
    `~50-70 % fewer tokens than general-purpose. ` +
    `Escape: add "ad-hoc" or "open-ended" to the description to bypass, or set ` +
    `TOKEN_PILOT_MODE=advisory for warn-only behaviour.`;

  const hardBlock =
    ctx.force ||
    ctx.mode === "strict" ||
    (ctx.mode === "deny" && hit.confidence === "high" && ctx.force);

  if (hardBlock) {
    return {
      kind: "deny",
      reason: suggestion,
    };
  }

  return { kind: "advise", message: suggestion };
}

/**
 * Render the Claude Code hook JSON response.
 *
 * - allow  → no output (pass-through)
 * - advise → permissionDecision=allow + additionalContext
 * - deny   → permissionDecision=deny + reason
 */
export function renderPreTaskOutput(decision: PreTaskDecision): string | null {
  if (decision.kind === "allow") return null;
  if (decision.kind === "advise") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: decision.message,
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}
