/**
 * Estimate token count for text content.
 * Uses a simple heuristic calibrated against cl100k_base.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 4);
  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / text.length;
  const adjustment = 1 - (whitespaceRatio * 0.3);
  return Math.ceil(charEstimate * adjustment);
}

/**
 * Format a token savings message.
 */
export function formatSavings(actual: number, wouldBe: number): string {
  if (wouldBe <= 0) return '';
  const saved = Math.round((1 - actual / wouldBe) * 100);
  return `TOKEN SAVINGS: ~${actual} tokens (structure) vs ~${wouldBe} tokens (full file) = ${saved}% saved`;
}
