/**
 * Adaptive threshold: lower the effective denyThreshold as session budget
 * drains, so large-file reads become stricter the deeper a session runs.
 *
 * Piecewise curve, opt-in only:
 *   burned <  30% of budget → base threshold unchanged
 *   burned ≥  30%, < 60%    → base × 0.75
 *   burned ≥  60%, < 80%    → base × 0.5
 *   burned ≥  80%           → base × 0.3 (minimum 50 lines)
 *
 * Burn fraction = sessionSavedTokens / sessionBudgetTokens.
 * Here sessionSavedTokens is the accumulated "would-be cost if nothing was
 * suppressed" proxy taken from hook-events.jsonl; it stands in for attention
 * pressure inside the model's context window.
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
