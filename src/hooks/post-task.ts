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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentIndex,
  matchTpAgent,
  type AgentIndex,
} from "../core/agent-matcher.js";
import { appendEvent } from "../core/event-log.js";

export const OVER_BUDGET_LOG = "over-budget.log";
/** Ratio above which we flag — 0.1 = 10 % grace. */
export const OVER_BUDGET_TOLERANCE = 0.1;

const BUDGET_RE = /Response budget:\s*~?\s*(\d{2,6})\s*tokens?/i;

export function parseAgentBudget(body: string): number | null {
  const m = body.match(BUDGET_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count approx tokens in the `tool_response.content[*].text` blocks of a
 * PostToolUse hook input for the Task tool. Returns null for anything
 * other than a well-formed Task response.
 */
export function extractSubagentTokens(input: {
  tool_name?: string;
  tool_response?: unknown;
}): number | null {
  if (input.tool_name !== "Task") return null;
  const resp = input.tool_response as
    | { content?: Array<{ type?: string; text?: string }> }
    | null
    | undefined;
  if (!resp || typeof resp !== "object") return null;
  const parts = Array.isArray(resp.content) ? resp.content : [];
  let chars = 0;
  for (const p of parts) {
    if (typeof p?.text === "string") chars += p.text.length;
  }
  if (chars === 0) return null;
  return Math.ceil(chars / 4);
}

export interface BudgetDecisionInput {
  agentName: string;
  budget: number | null;
  actualTokens: number;
}

export interface BudgetDecisionResult {
  overBudget: boolean;
  overByRatio: number;
  message: string | null;
}

export function decideBudgetAdvice(
  input: BudgetDecisionInput,
): BudgetDecisionResult {
  if (input.budget == null || input.budget <= 0) {
    return { overBudget: false, overByRatio: 0, message: null };
  }
  const allowed = input.budget * (1 + OVER_BUDGET_TOLERANCE);
  if (input.actualTokens <= allowed) {
    return {
      overBudget: false,
      overByRatio: input.actualTokens / input.budget - 1,
      message: null,
    };
  }
  const ratio = input.actualTokens / input.budget - 1;
  const pct = Math.round(ratio * 100);
  return {
    overBudget: true,
    overByRatio: ratio,
    message: `${input.agentName} exceeded budget (~${input.actualTokens} tokens vs budget ${input.budget}, +${pct}%). See .token-pilot/over-budget.log.`,
  };
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
 * then user-level. Returns null when neither exists. Non-tp-* subagents
 * are rejected up front so we never peek outside our namespace.
 */
export async function loadAgentBody(
  projectRoot: string,
  homeDir: string,
  agentName: string,
): Promise<string | null> {
  if (!agentName.startsWith("tp-")) return null;
  const candidates = [
    join(projectRoot, ".claude", "agents", `${agentName}.md`),
    join(homeDir, ".claude", "agents", `${agentName}.md`),
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
}

// ─── Cached tp-* agent index ─────────────────────────────────────────
// The hook subprocess is cold-started per Task post-event, but within
// that process we parse the agents directory once. Lookup cost is ~1 FS
// listing + 24 file reads, ~5-15 ms — below the noise floor of the hook
// round-trip. Kept as a process-level cache anyway for Pack 2 when the
// pre-task hook re-uses the same index on hot paths.

let _agentIndexCache: AgentIndex | null = null;

/**
 * Resolve the plugin's own `agents/` directory. The hook binary lives
 * at `<plugin>/dist/index.js`, so agents/ is `../agents` from here.
 * Allow an override for tests that want an isolated fixture dir.
 */
export function defaultAgentsDir(): string {
  // `import.meta.url` resolves to the bundled dist location, which is
  // already one step below the repo root (`dist/hooks/post-task.js`).
  // Walk up twice: `hooks` → `dist` → plugin root, then join `agents`.
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "..", "..", "agents");
  } catch {
    // Not running as a bundled module (eg. vitest in-source) — fall
    // back to CWD/agents. Production path uses the URL resolver above.
    return resolve(process.cwd(), "agents");
  }
}

/** Resolve (and cache) the tp-* agent index. Safe to call repeatedly. */
export async function getAgentIndex(
  dir: string = defaultAgentsDir(),
): Promise<AgentIndex> {
  if (_agentIndexCache) return _agentIndexCache;
  _agentIndexCache = await buildAgentIndex(dir);
  return _agentIndexCache;
}

/** Test-only: clear the module-level cache between fixtures. */
export function _resetAgentIndexCache(): void {
  _agentIndexCache = null;
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
  if (input.tool_name !== "Task") return null;

  const subagentType = input.tool_input?.subagent_type;
  const description = input.tool_input?.description ?? "";
  const actualTokens = extractSubagentTokens(input) ?? 0;
  const isTpAgent =
    typeof subagentType === "string" && subagentType.startsWith("tp-");

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
  // One event per Task call, regardless of tp-*. For non-tp agents we
  // run the heuristic matcher so `stats --tasks` can surface routing
  // misses (general-purpose picked when a tp-* would have fit).
  // Silent on any error — telemetry must never break hook dispatch.
  try {
    let matched: string | null = null;
    let matchConfidence: "high" | "low" | undefined;

    if (!isTpAgent && description.length > 0) {
      const index = await getAgentIndex();
      const hit = matchTpAgent(description, index);
      if (hit) {
        matched = hit.agent;
        matchConfidence = hit.confidence;
      }
    }

    await appendEvent(projectRoot, {
      ts: Date.now(),
      session_id: input.session_id ?? "",
      agent_type: input.agent_type ?? null,
      agent_id: input.agent_id ?? null,
      event: "task",
      file: "",
      lines: 0,
      estTokens: actualTokens,
      summaryTokens: 0,
      savedTokens: 0,
      subagent_type: typeof subagentType === "string" ? subagentType : "",
      matched_tp_agent: matched,
      ...(matchConfidence ? { match_confidence: matchConfidence } : {}),
      budget,
      overBudget: decision.overBudget,
    });
  } catch {
    /* silent */
  }

  return decision.message;
}
