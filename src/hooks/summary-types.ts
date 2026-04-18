/**
 * Shared types for the hook summary pipeline (Phase 1).
 *
 * Every parser in the fallback chain (ast-index subprocess, regex, head+tail)
 * returns a HookSummary. The downstream formatter in handleHookRead renders
 * this structure into the `permissionDecisionReason` body.
 */

export type SignalKind = "import" | "export" | "declaration" | "raw";

export interface SignalLine {
  /** 1-based line number in the original source. */
  line: number;
  kind: SignalKind;
  /** Trimmed source line, truncated to a parser-defined character cap. */
  text: string;
}

export interface HookSummary {
  signals: SignalLine[];
  totalLines: number;
  estimatedTokens: number;
  /** Lower-case extension without the dot; empty string if none. */
  language: string;
  /**
   * Optional human-readable note explaining a non-standard summary
   * (e.g. "parser unavailable — showing head+tail only"). Rendered by the
   * formatter above the signals section.
   */
  note?: string;
}
