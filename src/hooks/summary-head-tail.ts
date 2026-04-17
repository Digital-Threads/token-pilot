/**
 * Last-resort head+tail summary.
 *
 * When both ast-index and the regex parser fail (crashed, unsupported language,
 * malformed content), we still owe the caller *something* that respects the
 * summary shape. This module produces a degraded HookSummary showing the first
 * HEAD_LINES and last TAIL_LINES of the file as raw text, tagged with a note
 * so the formatter can explain to the reader why the output is coarse.
 *
 * The function is intentionally total: empty input, unicode-heavy input, and
 * absurdly large input all return a well-formed summary without throwing.
 */

import type { HookSummary, SignalLine } from "./summary-types.js";

const HEAD_LINES = 40;
const TAIL_LINES = 20;
const MAX_TEXT_LEN = 140;

function extractExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filePath.length - 1) return "";
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  if (ext.includes("/") || ext.includes("\\")) return "";
  return ext;
}

function truncate(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= MAX_TEXT_LEN) return trimmed;
  return trimmed.slice(0, MAX_TEXT_LEN - 1) + "…";
}

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 4);
  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / text.length;
  const adjustment = 1 - whitespaceRatio * 0.3;
  return Math.ceil(charEstimate * adjustment);
}

export function parseHeadTailSummary(
  content: string,
  filePath: string,
): HookSummary {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const language = extractExtension(filePath);
  const estimatedTokens = estimateTokens(content);

  // When the file fits within HEAD_LINES + TAIL_LINES we include everything
  // and omit the degradation note — no truncation actually happened.
  if (totalLines <= HEAD_LINES + TAIL_LINES) {
    const signals: SignalLine[] = lines.map((line, i) => ({
      line: i + 1,
      kind: "raw",
      text: truncate(line),
    }));
    return {
      signals,
      totalLines,
      estimatedTokens,
      language,
    };
  }

  const head: SignalLine[] = lines.slice(0, HEAD_LINES).map((line, i) => ({
    line: i + 1,
    kind: "raw",
    text: truncate(line),
  }));

  const tailStart = totalLines - TAIL_LINES;
  const tail: SignalLine[] = lines.slice(tailStart).map((line, i) => ({
    line: tailStart + i + 1,
    kind: "raw",
    text: truncate(line),
  }));

  return {
    signals: [...head, ...tail],
    totalLines,
    estimatedTokens,
    language,
    note: `parser unavailable — showing head+tail (first ${HEAD_LINES} and last ${TAIL_LINES} lines of ${totalLines})`,
  };
}
