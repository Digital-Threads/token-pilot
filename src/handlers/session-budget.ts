/**
 * TP-hsz — `session_budget` MCP tool.
 *
 * Reports *hook pressure* for the current session: the total tokens the
 * Read-hook has suppressed so far (`savedTokens` in hook-events.jsonl)
 * divided by a configurable reference budget. This is a proxy for "how
 * chatty is the agent being with big files", not a measurement of the
 * Claude Code context window itself — Token Pilot has no visibility into
 * what the model actually has in context.
 *
 * The adaptive threshold curve uses this same signal to tighten when
 * pressure is high, so `burnFraction` here matches what the hook sees.
 * An agent that Reads many files with bounded `offset/limit` will see a
 * low `burnFraction` even if its context is nearly full — the budget is
 * about Token Pilot interventions, not total window occupancy.
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
    semantics:
      "burnFraction is hook-suppression pressure, NOT context-window occupancy. See session-budget.ts docs.",
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
