/**
 * A tp-* agent declares "Response budget: ~N tokens" in its body; these
 * decide whether an answer went over it. No Node here: the CLI hooks and the
 * Claude Code mod share it.
 */

/** Ratio above which we flag — 0.1 = 10 % grace. */
export const OVER_BUDGET_TOLERANCE = 0.1;

const BUDGET_RE = /Response budget:\s*~?\s*(\d{2,6})\s*tokens?/i;

export function parseAgentBudget(body: string): number | null {
  const m = body.match(BUDGET_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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
