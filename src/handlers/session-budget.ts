/**
 * TP-hsz — `session_budget` MCP tool.
 *
 * Lets the agent interrogate its own session state: how much budget has
 * been burned so far, what denyThreshold would be applied right now, and
 * whether adaptive mode is on. Cheap single-line JSON payload — under
 * 100 tokens — so the agent can poll between long-running operations.
 */

import { loadSessionStats } from "../core/session-savings.js";
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
  const stats = loadSessionStats(projectRoot, sessionId);
  const savedTokens = stats.savedTokens;

  const budget = cfg.adaptiveBudgetTokens > 0 ? cfg.adaptiveBudgetTokens : 0;
  const burnRaw = budget > 0 ? savedTokens / budget : 0;
  const burnFraction = Math.min(1, Math.max(0, burnRaw));

  const effectiveThreshold = computeEffectiveThreshold({
    baseThreshold: cfg.baseThreshold,
    sessionSavedTokens: savedTokens,
    sessionBudgetTokens: budget,
    enabled: cfg.adaptiveThreshold,
  });

  // Time-to-compact projection. Silent (null fields) when we lack data.
  let avgSavedPerEvent: number | null = null;
  let eventsUntilExhaustion: number | null = null;
  if (stats.eventCount > 0 && savedTokens > 0) {
    avgSavedPerEvent = savedTokens / stats.eventCount;
    if (budget > 0 && avgSavedPerEvent > 0) {
      const remaining = Math.max(0, budget - savedTokens);
      eventsUntilExhaustion = Math.floor(remaining / avgSavedPerEvent);
    }
  }

  const payload = {
    sessionId,
    savedTokens,
    budgetTokens: budget,
    burnFraction: Number(burnFraction.toFixed(4)),
    baseThreshold: cfg.baseThreshold,
    effectiveThreshold,
    adaptive: cfg.adaptiveThreshold,
    eventCount: stats.eventCount,
    avgSavedPerEvent:
      avgSavedPerEvent != null ? Math.round(avgSavedPerEvent) : null,
    eventsUntilExhaustion,
    firstEventMs: stats.firstTsMs,
    lastEventMs: stats.lastTsMs,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}
