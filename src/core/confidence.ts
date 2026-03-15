/**
 * Confidence metadata — tells the LLM how complete the response is
 * and what follow-up actions might be needed.
 * Track 5: Confidence-Based Escalation
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ConfidenceMetadata {
  confidence: ConfidenceLevel;
  knownUnknowns: string[];
  suggestedNextStep?: string;
}

export interface ConfidenceInput {
  symbolResolved?: boolean;
  fullFile?: boolean;
  truncated?: boolean;
  hasTests?: boolean;
  hasCallers?: boolean;
  crossFileDeps?: number;
  refsFound?: boolean;
  astAvailable?: boolean;
  dedupHit?: boolean;
}

/**
 * Assess confidence level based on response completeness signals.
 */
export function assessConfidence(input: ConfidenceInput): ConfidenceMetadata {
  const unknowns: string[] = [];
  let score = 0;

  // Positive signals
  if (input.symbolResolved) score += 3;
  if (input.fullFile) score += 2;
  if (input.hasTests) score += 1;
  if (input.hasCallers) score += 1;
  if (input.refsFound) score += 2;
  if (input.astAvailable) score += 1;

  // Negative signals
  if (input.truncated) {
    score -= 2;
    unknowns.push('output was truncated — some content not shown');
  }
  if (input.crossFileDeps !== undefined && input.crossFileDeps > 3) {
    score -= 1;
    unknowns.push(`${input.crossFileDeps} cross-file dependencies not explored`);
  }
  if (input.symbolResolved === false) {
    score -= 2;
    unknowns.push('target symbol not resolved');
  }
  if (input.astAvailable === false) {
    score -= 1;
    unknowns.push('AST index unavailable — structural analysis limited');
  }
  if (input.hasTests === false) {
    unknowns.push('no test file found for this module');
  }

  // Dedup hit is informational, not a quality issue
  if (input.dedupHit) {
    score += 1; // already known = high confidence in context
  }

  // Determine level
  let confidence: ConfidenceLevel;
  if (score >= 5) {
    confidence = 'high';
  } else if (score >= 2) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Generate suggested next step based on unknowns
  let suggestedNextStep: string | undefined;

  if (input.truncated) {
    suggestedNextStep = 'use read_range() or read_symbol() with show="full" for remaining content';
  } else if (input.symbolResolved === false) {
    suggestedNextStep = 'use smart_read() to see available symbols, then read_symbol() for the target';
  } else if (input.astAvailable === false) {
    suggestedNextStep = 'structural reading unavailable — use read_range() for raw content';
  } else if (input.crossFileDeps !== undefined && input.crossFileDeps > 3) {
    suggestedNextStep = 'use find_usages() or related_files() to explore cross-file dependencies';
  }

  const result: ConfidenceMetadata = { confidence, knownUnknowns: unknowns };
  if (suggestedNextStep) {
    result.suggestedNextStep = suggestedNextStep;
  }

  return result;
}

/**
 * Format confidence metadata as a text section for tool output.
 */
export function formatConfidence(meta: ConfidenceMetadata): string {
  const lines: string[] = [
    '',
    `CONFIDENCE: ${meta.confidence}`,
  ];

  if (meta.knownUnknowns.length > 0) {
    lines.push(`KNOWN UNKNOWNS: ${meta.knownUnknowns.join('; ')}`);
  } else {
    lines.push('KNOWN UNKNOWNS: none');
  }

  if (meta.suggestedNextStep) {
    lines.push(`SUGGESTED: ${meta.suggestedNextStep}`);
  }

  return lines.join('\n');
}
