/**
 * Adaptive threshold: lower the effective denyThreshold as the Read-hook
 * sees more suppressed-token activity in this session, so large-file reads
 * become stricter the chattier the agent has been with big files.
 *
 * Piecewise curve, opt-in only:
 *   pressure <  30% of budget → base threshold unchanged
 *   pressure ≥  30%, < 60%    → base × 0.75
 *   pressure ≥  60%, < 80%    → base × 0.5
 *   pressure ≥  80%           → base × 0.3 (minimum 50 lines)
 *
 * Burn fraction = sessionSavedTokens / sessionBudgetTokens, where
 * `sessionSavedTokens` is the sum of `savedTokens` entries in
 * hook-events.jsonl for the current session_id. This is a PROXY for how
 * aggressively the agent has been trying to pull large files, not a
 * measurement of Claude Code's actual context-window occupancy — Token
 * Pilot has no visibility into that. If the agent reads many files with
 * bounded `offset/limit`, none of that contributes to the burn signal.
 */

export interface AdaptiveThresholdInput {
  baseThreshold: number;
  sessionSavedTokens: number;
  sessionBudgetTokens: number;
  enabled: boolean;
}

const MIN_FLOOR_LINES = 50;

export function computeEffectiveThreshold(
  input: AdaptiveThresholdInput,
): number {
  const { baseThreshold, sessionSavedTokens, sessionBudgetTokens, enabled } =
    input;

  if (!enabled) return baseThreshold;
  if (!Number.isFinite(sessionBudgetTokens) || sessionBudgetTokens <= 0) {
    return baseThreshold;
  }
  if (!Number.isFinite(sessionSavedTokens) || sessionSavedTokens <= 0) {
    return baseThreshold;
  }

  const burn = sessionSavedTokens / sessionBudgetTokens;

  let multiplier: number;
  if (burn < 0.3) multiplier = 1;
  else if (burn < 0.6) multiplier = 0.75;
  else if (burn < 0.8) multiplier = 0.5;
  else multiplier = 0.3;

  const scaled = Math.round(baseThreshold * multiplier);
  if (multiplier === 1) return baseThreshold;
  return Math.max(scaled, MIN_FLOOR_LINES);
}
