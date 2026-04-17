/**
 * Summary-generation pipeline for the deny-enhanced hook.
 *
 * Tries three parsers in order — ast-index subprocess → regex → head+tail —
 * and returns the first result with non-empty signals. If every parser
 * fails to produce useful output (or throws), the pipeline reports
 * `pass-through`, at which point the handler lets the original Read
 * proceed unmodified rather than emitting an empty / misleading denial.
 *
 * Each parser is injectable for tests. The default wiring uses the
 * real implementations from sibling modules.
 */

import { parseAstIndexSummary } from "./summary-ast-index.js";
import { parseRegexSummary } from "./summary-regex.js";
import { parseHeadTailSummary } from "./summary-head-tail.js";
import type { HookSummary } from "./summary-types.js";

export type PipelineTier = "ast-index" | "regex" | "head-tail";

export type PipelineResult =
  | { kind: "summary"; summary: HookSummary; tier: PipelineTier }
  | { kind: "pass-through"; reason: string };

type AstIndexFn = (
  content: string,
  filePath: string,
) => Promise<HookSummary | null>;
type SyncSummaryFn = (content: string, filePath: string) => HookSummary;

export interface PipelineOptions {
  /** Primary parser — ast-index subprocess. Returns null on soft fail. */
  astIndex?: AstIndexFn;
  /** Fallback parser — regex. Expected to always return a HookSummary. */
  regex?: SyncSummaryFn;
  /** Last-resort parser — head+tail. Expected to always return a HookSummary. */
  headTail?: SyncSummaryFn;
}

const defaultAstIndex: AstIndexFn = async (content, filePath) =>
  parseAstIndexSummary(content, filePath);

const defaultRegex: SyncSummaryFn = parseRegexSummary;

const defaultHeadTail: SyncSummaryFn = parseHeadTailSummary;

function hasSignals(
  summary: HookSummary | null | undefined,
): summary is HookSummary {
  return !!summary && summary.signals.length > 0;
}

async function tryAsync<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function trySync<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export async function runSummaryPipeline(
  content: string,
  filePath: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const astIndex = options.astIndex ?? defaultAstIndex;
  const regex = options.regex ?? defaultRegex;
  const headTail = options.headTail ?? defaultHeadTail;

  // Tier 1 — ast-index. Soft-fails on null or throw.
  const astResult = await tryAsync(() => astIndex(content, filePath));
  if (hasSignals(astResult)) {
    return { kind: "summary", summary: astResult, tier: "ast-index" };
  }

  // Tier 2 — regex. Empty signals means "nothing useful here, try next".
  const regexResult = trySync(() => regex(content, filePath));
  if (hasSignals(regexResult)) {
    return { kind: "summary", summary: regexResult, tier: "regex" };
  }

  // Tier 3 — head+tail. Always produces *something*, unless the parser
  // itself crashes (in which case we pass-through).
  const headTailResult = trySync(() => headTail(content, filePath));
  if (hasSignals(headTailResult)) {
    return { kind: "summary", summary: headTailResult, tier: "head-tail" };
  }

  return {
    kind: "pass-through",
    reason: "all parsers returned empty or threw",
  };
}
