/**
 * TP-q33(a) — PostToolUse:Task budget enforcement.
 *
 * Claude Code's `Task` tool is how subagents are dispatched. When one
 * returns, this hook:
 *   1. Identifies the subagent by `tool_input.subagent_type`.
 *   2. Loads its agent markdown (project first, then ~/.claude/agents).
 *   3. Reads the `Response budget: ~N tokens` line from the body.
 *   4. Counts tokens in the `tool_response` body (chars/4 heuristic).
 *   5. If actual > budget × (1 + OVER_BUDGET_TOLERANCE), append a JSONL
 *      entry to `.token-pilot/over-budget.log`.
 *
 * Silent on every failure — telemetry must never break the agent loop.
 * Non-tp-* subagents are ignored (we only enforce our own contracts).
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { bareAgentName, isDispatchTool } from "../core/dispatch.js";
import { appendEvent } from "../core/event-log.js";
import {
  decideBudgetAdvice,
  parseAgentBudget,
  type BudgetDecisionResult,
} from "./agent-budget.js";

export const OVER_BUDGET_LOG = "over-budget.log";
export {
  OVER_BUDGET_TOLERANCE,
  parseAgentBudget,
  decideBudgetAdvice,
} from "./agent-budget.js";
export type {
  BudgetDecisionInput,
  BudgetDecisionResult,
} from "./agent-budget.js";
/**
 * Extract the subagent's token count from a PostToolUse:Task hook input.
 *
 * v0.37.0 — the Task tool's `tool_response` carries an authoritative
 * `totalTokens` field. Verified by inspecting the Claude Code 2.1.131
 * bundle: the Task result object is
 *   { agentId, agentType, content, totalDurationMs, totalTokens, totalToolUseCount, usage }
 * Earlier versions of this function only summed `content[*].text`
 * lengths / 4 — a rough heuristic that returned 0 whenever the
 * response wasn't a `{content:[{text}]}` array, leaving the budget
 * watchdog and task token-weighting permanently at zero.
 *
 * Resolution order:
 *   1. `tool_response.totalTokens` (exact, preferred)
 *   2. `tool_response.usage.output_tokens` (exact, alternate shape)
 *   3. char/4 over `content[*].text` (legacy heuristic fallback)
 *   4. char/4 over a plain string `content`
 *
 * Returns null only when no signal at all is available.
 */
export function extractSubagentTokens(input: {
  tool_name?: string;
  tool_response?: unknown;
}): number | null {
  if (!isDispatchTool(input.tool_name)) return null;
  const resp = input.tool_response as
    | {
        totalTokens?: unknown;
        usage?: { output_tokens?: unknown; total_tokens?: unknown };
        content?: unknown;
      }
    | null
    | undefined;
  if (!resp || typeof resp !== "object") return null;

  // 1. Authoritative totalTokens.
  if (typeof resp.totalTokens === "number" && resp.totalTokens > 0) {
    return Math.round(resp.totalTokens);
  }
  // 2. usage shape (alternate / future-proof).
  const usage = resp.usage;
  if (usage && typeof usage === "object") {
    const out = usage.total_tokens ?? usage.output_tokens;
    if (typeof out === "number" && out > 0) return Math.round(out);
  }
  // 3. Legacy heuristic over content[*].text.
  if (Array.isArray(resp.content)) {
    let chars = 0;
    for (const p of resp.content) {
      if (p && typeof (p as { text?: unknown }).text === "string") {
        chars += (p as { text: string }).text.length;
      }
    }
    if (chars > 0) return Math.ceil(chars / 4);
  }
  // 4. Plain-string content.
  if (typeof resp.content === "string" && resp.content.length > 0) {
    return Math.ceil(resp.content.length / 4);
  }
  return null;
}

export interface OverBudgetEntry {
  ts: number;
  agent: string;
  budget: number;
  actualTokens: number;
  overByRatio: number;
}

export async function appendOverBudgetLog(
  projectRoot: string,
  entry: OverBudgetEntry,
): Promise<void> {
  try {
    const dir = join(projectRoot, ".token-pilot");
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(join(dir, OVER_BUDGET_LOG), line);
  } catch {
    /* silent — logging must never break the hook */
  }
}

/**
 * Locate the markdown body for a `tp-*` subagent — project-level first,
 * then user-level (copies install-agents wrote before the plugin stopped
 * shipping agents). Returns null when
 * none exists. Non-tp-* subagents are rejected up front so we never peek
 * outside our namespace; a plugin namespace (`token-pilot:`) is dropped
 * before that check.
 */
export async function loadAgentBody(
  projectRoot: string,
  homeDir: string,
  agentName: string,
): Promise<string | null> {
  const name = bareAgentName(agentName);
  if (!name.startsWith("tp-")) return null;

  const candidates = [
    join(projectRoot, ".claude", "agents", `${name}.md`),
    join(homeDir, ".claude", "agents", `${name}.md`),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface PostTaskHookInput {
  tool_name?: string;
  tool_input?: { subagent_type?: string; description?: string };
  tool_response?: unknown;
  // Claude Code enriches every hook stdin with these top-level fields.
  // Null-safe downstream so old fixtures without them keep working.
  session_id?: string;
  agent_type?: string;
  agent_id?: string;
  /**
   * v0.34.0 — Claude Code now passes the dispatching agent's id so
   * we can reconstruct the full delegation chain. Older versions
   * never populate it.
   */
  parent_agent_id?: string;
}

/**
 * Full post-Task processing: read frontmatter, count tokens, log over-budget.
 * Returns the advice message (or null) so the caller can optionally emit
 * `additionalContext` — though the primary output channel is the log file.
 */
export async function processPostTask(
  projectRoot: string,
  homeDir: string,
  input: PostTaskHookInput,
): Promise<string | null> {
  if (!isDispatchTool(input.tool_name)) return null;

  const subagentType = input.tool_input?.subagent_type;
  const actualTokens = extractSubagentTokens(input) ?? 0;
  // Plugin agents arrive namespaced (`token-pilot:tp-run`).
  const isTpAgent =
    typeof subagentType === "string" &&
    bareAgentName(subagentType).startsWith("tp-");

  // ─── existing tp-* budget logic (unchanged) ─────────────────────
  let budget: number | null = null;
  let decision: BudgetDecisionResult = {
    overBudget: false,
    overByRatio: 0,
    message: null,
  };

  if (isTpAgent && actualTokens > 0) {
    const body = await loadAgentBody(projectRoot, homeDir, subagentType!);
    budget = body ? parseAgentBudget(body) : null;
    decision = decideBudgetAdvice({
      agentName: subagentType!,
      budget,
      actualTokens,
    });
    if (decision.overBudget && budget != null) {
      await appendOverBudgetLog(projectRoot, {
        ts: Date.now(),
        agent: subagentType!,
        budget,
        actualTokens,
        overByRatio: decision.overByRatio,
      });
    }
  }

  // ─── v0.31.0 Task telemetry ────────────────────────────────────
  // One event per Task call. Silent on any error — telemetry must never
  // break hook dispatch.
  try {
    await appendEvent(projectRoot, {
      ts: Date.now(),
      session_id: input.session_id ?? "",
      agent_type: input.agent_type ?? null,
      agent_id: input.agent_id ?? null,
      // v0.34.0 — capture parent_agent_id when Claude Code provides it.
      // Lets us reconstruct main → general-purpose → tp-* chains.
      ...(input.parent_agent_id
        ? { parent_agent_id: input.parent_agent_id }
        : {}),
      event: "task",
      file: "",
      lines: 0,
      estTokens: actualTokens,
      summaryTokens: 0,
      savedTokens: 0,
      subagent_type: typeof subagentType === "string" ? subagentType : "",
      matched_tp_agent: null,
      budget,
      overBudget: decision.overBudget,
      // SubagentStop writes the canonical task event for the same dispatch;
      // this marks the second one so readers can tell them apart.
      code: "post_tool_use",
    });
  } catch {
    /* silent */
  }

  return decision.message;
}
