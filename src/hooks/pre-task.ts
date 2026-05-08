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
 * v0.33.0 (B14) — generic context appended to every advice payload
 * for non-tp-* dispatches. Subagents like `general-purpose` and
 * `code-analyzer` don't know about the token-pilot MCP tools and
 * loop on raw `Read` even after `hook-pre-read` denies them. This
 * paragraph lands in their context window before they take their
 * first action and tells them what to use instead.
 */
const SUBAGENT_TOOL_GUIDE =
  "When working in this task: prefer `mcp__token-pilot__smart_read` " +
  "(file structure), `read_symbol` (one function/class), and " +
  "`find_usages` (semantic search) over raw Read/Grep. The token-pilot " +
  "PreToolUse hooks block large-file Read and unbounded Grep — use " +
  "the MCP tools or pass `offset`/`limit` to Read.";

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

  // No description → nothing to match against. Inject the generic
  // tool-guide so the subagent still picks tp-tools (B14).
  if (!description || description.length === 0) {
    return { kind: "advise", message: SUBAGENT_TOOL_GUIDE };
  }

  // Author-blessed escape clauses — user is explicitly saying
  // "this is broad". Inject the tool-guide but no agent suggestion.
  if (containsEscape(description)) {
    return { kind: "advise", message: SUBAGENT_TOOL_GUIDE };
  }

  const hit = matchTpAgent(description, ctx.agentIndex);
  if (!hit) {
    // No specific tp-* match. Still send the generic tool-guide so
    // the subagent learns about smart_read / read_symbol — covers the
    // common code-analyzer / general-purpose loop on raw Read (B14).
    return { kind: "advise", message: SUBAGENT_TOOL_GUIDE };
  }

  const suggestion =
    `Consider dispatching \`${hit.agent}\` instead of \`${subagentType || "general-purpose"}\` — ` +
    `the description matches its trigger phrases (confidence: ${hit.confidence}). ` +
    `tp-* agents run under a tighter budget and output in terse style, typically ` +
    `~50-70 % fewer tokens than general-purpose. ` +
    `Escape: add "ad-hoc" or "open-ended" to the description to bypass, or set ` +
    `TOKEN_PILOT_MODE=advisory for warn-only behaviour.\n\n` +
    SUBAGENT_TOOL_GUIDE;

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
