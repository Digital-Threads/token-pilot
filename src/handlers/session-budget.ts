/**
 * TP-hsz — `session_budget` MCP tool.
 *
 * Lets the agent interrogate its own session state: how much budget has
 * been burned so far, what denyThreshold would be applied right now, and
 * whether adaptive mode is on. Cheap single-line JSON payload — under
 * 100 tokens — so the agent can poll between long-running operations.
 */

import { loadSessionSavedTokens } from "../core/session-savings.js";
import { computeEffectiveThreshold } from "../hooks/adaptive-threshold.js";

export interface SessionBudgetArgs {
  sessionId: string;
}

export interface SessionBudgetConfig {
  baseThreshold: number;
  adaptiveThreshold: boolean;
  adaptiveBudgetTokens: number;
}

export interface SessionBudgetResult {
  content: Array<{ type: "text"; text: string }>;
}

export async function handleSessionBudget(
  args: SessionBudgetArgs,
  projectRoot: string,
  cfg: SessionBudgetConfig,
): Promise<SessionBudgetResult> {
  const sessionId = args.sessionId ?? "";
  const savedTokens = loadSessionSavedTokens(projectRoot, sessionId);

  const budget = cfg.adaptiveBudgetTokens > 0 ? cfg.adaptiveBudgetTokens : 0;
  const burnRaw = budget > 0 ? savedTokens / budget : 0;
  const burnFraction = Math.min(1, Math.max(0, burnRaw));

  const effectiveThreshold = computeEffectiveThreshold({
    baseThreshold: cfg.baseThreshold,
    sessionSavedTokens: savedTokens,
    sessionBudgetTokens: budget,
    enabled: cfg.adaptiveThreshold,
  });

  const payload = {
    sessionId,
    savedTokens,
    budgetTokens: budget,
    burnFraction: Number(burnFraction.toFixed(4)),
    baseThreshold: cfg.baseThreshold,
    effectiveThreshold,
    adaptive: cfg.adaptiveThreshold,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}
