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
 *   1. tool_name is not Agent (or legacy Task)       → allow
 *   2. subagent_type ∈ tp-*                          → allow
 *   3. FORCE_SUBAGENTS=1 with no tp-* installed      → deny (says why)
 *   4. subagent_type set, not general-purpose        → allow
 *      (Plan, Explore, code-analyzer, … were picked on purpose)
 *   5. description/prompt carries an ESCAPE phrase   → allow
 *   6. no match, or a low-confidence one             → allow, silently
 *      (low-confidence suggestions were wrong as often as not)
 *   7. multi-word trigger phrase + deny/strict/force → deny
 *   8. any other high-confidence match               → advise
 *
 * The subagent tool guide is not part of any decision: it is meant for
 * the subagent, so the Claude Code mod appends it to the subagent's prompt.
 *
 * Pure decide — all context (agent index, env, mode) is pre-resolved
 * by the caller so the function stays deterministic and unit-testable.
 */

import type { EnforcementMode } from "../server/enforcement-mode.js";
import { toolPrefix } from "../core/tool-names.js";
import type { AgentIndex } from "../core/agent-matcher.js";
import {
  bareAgentName,
  isDispatchTool,
  matchTpAgent,
} from "../core/agent-matcher.js";

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
  /**
   * Namespace Claude Code puts in front of a plugin's agents
   * (`token-pilot:`), so a suggestion names an agent that can actually be
   * dispatched. Empty for npm installs, whose agents are bare `tp-*`.
   */
  agentNamePrefix?: string;
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
 * v0.33.0 (B14) — subagents like `general-purpose` and `code-analyzer`
 * don't know about the token-pilot MCP tools and loop on raw `Read`. The
 * Claude Code mod appends this to their prompt, where they read it before
 * their first action. Built per call: the mod marks a plugin install only
 * after this module is imported, so an import-time string named the npm tools.
 */
export const subagentToolGuide = (): string =>
  `When working in this task: prefer \`${toolPrefix()}smart_read\` ` +
  "(file structure), `read_symbol` (one function/class), and " +
  "`find_usages` (semantic search) over reading whole files. token-pilot's " +
  "hooks answer a large whole-file Read with an outline and block unbounded " +
  "searches — use the MCP tools or pass `offset`/`limit` to Read.";

/** Every dispatched subagent except our own tp-* ones, which know the tools. */
export function subagentNeedsToolGuide(input: PreTaskInput): boolean {
  if (!isDispatchTool(input.tool_name)) return false;
  const type = input.tool_input?.subagent_type;

  return !(typeof type === "string" && bareAgentName(type).startsWith("tp-"));
}

/**
 * Pure decision function. Caller resolves all context (env, mode,
 * agent index) up front so this stays a plain input → output mapping.
 */
export function decidePreTask(
  input: PreTaskInput,
  ctx: PreTaskContext,
): PreTaskDecision {
  if (!isDispatchTool(input.tool_name)) return { kind: "allow" };

  const subagentType = input.tool_input?.subagent_type ?? "";
  // Type-guarded, not just defaulted: a non-string description survives
  // `!description`, has no `.length`, and reaches containsEscape as a
  // non-string — which throws. Hook input is external data.
  const description =
    typeof input.tool_input?.description === "string"
      ? input.tool_input.description
      : "";

  // Already a tp-* — routing intent matches catalog. Let it run. Plugin
  // agents arrive namespaced (`token-pilot:tp-run`).
  if (
    typeof subagentType === "string" &&
    bareAgentName(subagentType).startsWith("tp-")
  ) {
    return { kind: "allow" };
  }

  // v0.33.0 (B4) — TOKEN_PILOT_FORCE_SUBAGENTS=1 with an empty agent
  // catalog used to silently allow every Task call (no matches → no
  // suggestion). That defeats the env's only purpose. Fail loud
  // instead: tell the user to install the templates.
  const indexEmpty =
    !ctx.agentIndex.agents || ctx.agentIndex.agents.length === 0;
  if (ctx.force && indexEmpty) {
    return {
      kind: "deny",
      reason:
        "TOKEN_PILOT_FORCE_SUBAGENTS=1 is set but no tp-* agents are " +
        "installed in this project (or `~/.claude/agents/`). " +
        "Run `npx token-pilot install-agents --scope=project` first, " +
        "or unset TOKEN_PILOT_FORCE_SUBAGENTS.",
    };
  }

  // Only a generic dispatch is re-routed. Any other agent type was picked
  // for what it is; second-guessing it cost real work (the built-in Plan
  // agent was blocked on the word "plan").
  if (subagentType && subagentType !== "general-purpose") {
    return { kind: "allow" };
  }

  // v0.50.0 — the prompt is matched too: descriptions are a few words and
  // alone almost never reach the high-confidence tier. 1.0.0 — the prompt
  // counts only through quoted trigger phrases (see scoreAgent): its generic
  // words were forcing confident wrong matches on long prompts.
  const prompt =
    typeof input.tool_input?.prompt === "string" ? input.tool_input.prompt : "";
  const haystack = prompt ? `${description} ${prompt}` : description;

  // Nothing to match, or an author-blessed escape clause ("this is broad"),
  // checked across the prompt too.
  if (haystack.trim().length === 0 || containsEscape(haystack)) {
    return { kind: "allow" };
  }

  // A low-confidence suggestion was wrong as often as not ("fix tests" →
  // tp-commit-writer); it is not worth the parent's attention.
  const hit = matchTpAgent(description, ctx.agentIndex, prompt);
  if (!hit || hit.confidence === "low") return { kind: "allow" };

  const suggestion =
    `Consider dispatching \`${ctx.agentNamePrefix ?? ""}${hit.agent}\` instead of \`${subagentType || "general-purpose"}\` — ` +
    `the description matches its trigger phrases (confidence: ${hit.confidence}). ` +
    `tp-* agents run under a tighter budget and output in terse style, typically ` +
    `~50-70 % fewer tokens than general-purpose. ` +
    `Escape: add "ad-hoc" or "open-ended" to the description to bypass, or set ` +
    `TOKEN_PILOT_MODE=advisory for warn-only behaviour.`;

  // v0.50.0 — an advisory rides along as permissionDecision=allow, which the
  // model ignored on ten of eleven dispatches (57,921 tokens through
  // general-purpose against 18,677 through tp-run); reads are disciplined
  // because they come back denied. 1.0.2 — only an author's multi-word
  // trigger phrase is strong enough to block on: keyword scores and
  // one-word triggers ("plan") blocked unrelated work.
  const hardBlock =
    hit.phrase &&
    (ctx.force || ctx.mode === "strict" || ctx.mode === "deny");

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
 * - allow  → no output (pass-through), UNLESS `append` carries a fleet
 *            budget note — then emit it as additionalContext so the note
 *            still reaches the agent.
 * - advise → additionalContext (+ append)
 * - deny   → permissionDecision=deny + reason (+ append)
 *
 * Advice and notes carry no permissionDecision: "allow" would skip the
 * user's permission prompt.
 *
 * v0.38.0 — `append` is an optional trailing string (the workflow
 * near-budget wind-down note). Empty / omitted leaves output unchanged.
 */
export function renderPreTaskOutput(
  decision: PreTaskDecision,
  append = "",
): string | null {
  const extra = append || "";
  if (decision.kind === "allow") {
    if (!extra) return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: extra.trimStart(),
      },
    });
  }
  if (decision.kind === "advise") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: decision.message + extra,
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason + extra,
    },
  });
}
