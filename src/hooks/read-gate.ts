/**
 * The Read gate's decision, separated from the file I/O so the CLI hook and
 * the Claude Code mod reach the same verdict on the same content. Path
 * safety (symlinks, project root) stays with the caller, which can resolve
 * real paths.
 */

/** Code files, for every gate: Read, Edit and the shell (pre-bash). */
export const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "cs",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "c",
  "h",
  "php",
  "rb",
  "scala",
  "dart",
  "lua",
  "sh",
  "bash",
  "zsh",
  "clj",
  "elm",
  "ml",
  "fs",
  "sql",
  "r",
  "vue",
  "svelte",
  "pl",
  "pm",
  "ex",
  "exs",
  "groovy",
  "m",
  "proto",
  "bsl",
  "lisp",
  "lsp",
  "cl",
  "asd",
]);

/**
 * v0.45.0 (token-pilot-xg9) — how many lines a Read actually pulls.
 *
 * An unbounded Read (no offset/limit) pulls the whole file. A bounded Read
 * pulls `limit` lines starting at `offset` — but Claude Code's Read defaults
 * to a 2000-line page, so `Read(file, limit=2000)` or an offset with no limit
 * drags a whole big file through. The old hook passed ANY bounded Read
 * straight through (`hasOffset || hasLimit → return null`), which is the leak:
 * the model bounds with a large/default limit and reads everything hook-free
 * AND un-counted in the adaptive burn signal. Comparing the *span* against the
 * deny threshold closes that while still letting a genuinely narrow slice pass.
 *
 * `offset` / `limit` are null when the field is absent on the tool call.
 */
export function effectiveReadSpanLines(
  totalLines: number,
  offset: number | null,
  limit: number | null,
): number {
  // Claude Code's Read schema wants a positive limit; one of 0 or less that
  // reaches the gate anyway counts as no limit, never as a zero-line read.
  const lim = limit != null && limit > 0 ? limit : null;
  if (offset == null && lim == null) return totalLines;
  const DEFAULT_READ_PAGE = 2000;
  const start = offset != null && offset > 0 ? offset : 0;
  const page = lim ?? DEFAULT_READ_PAGE;
  return Math.max(0, Math.min(page, totalLines - start));
}

export function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(filePath.split(".").pop()?.toLowerCase() ?? "");
}

/** A line of code rarely runs past this; a span bigger than threshold × it is a bundle. */
const BYTES_PER_LINE = 100;

export type ReadGate =
  | { kind: "pass" }
  | { kind: "gate"; lineCount: number; spanLines: number; estTokens: number };

/**
 * True when the Read is bounded tightly enough to pass whatever the file's
 * size: with a `limit`, the span is never more than the limit.
 */
export function spanCannotExceed(
  offset: number | null,
  limit: number | null,
  threshold: number,
): boolean {
  return limit != null && limit > 0 && limit <= threshold;
}

function gateFromCounts(
  lineCount: number,
  chars: number,
  wsRatio: number,
  offset: number | null,
  limit: number | null,
  threshold: number,
): ReadGate {
  const spanLines = effectiveReadSpanLines(lineCount, offset, limit);
  // Cost reflects the span the read would pull, not the whole file
  // (v0.45.0, token-pilot-xg9), so a bounded gate doesn't over-report.
  const spanRatio = lineCount > 0 ? Math.min(1, spanLines / lineCount) : 1;
  // Lines alone let a one-line minified bundle through whole: the span's
  // size counts too, at a generous BYTES_PER_LINE per allowed line.
  if (spanLines <= threshold && chars * spanRatio <= threshold * BYTES_PER_LINE) {
    return { kind: "pass" };
  }

  const charEst = Math.ceil((chars * spanRatio) / 4);

  return {
    kind: "gate",
    lineCount,
    spanLines,
    estTokens: Math.ceil(charEst * (1 - wsRatio * 0.3)),
  };
}

/** Decide on content the caller already read. */
export function decideReadGate(input: {
  filePath: string;
  content: string;
  offset: number | null;
  limit: number | null;
  threshold: number;
}): ReadGate {
  if (!isCodeFile(input.filePath)) return { kind: "pass" };

  const wsRatio = (input.content.match(/\s/g)?.length ?? 0) / input.content.length;

  return gateFromCounts(
    input.content.split("\n").length,
    input.content.length,
    wsRatio,
    input.offset,
    input.limit,
    input.threshold,
  );
}

/**
 * Decide from a line count and a byte size, for a file too large to read
 * whole (the Claude Code mod's `$.fs.read` stops at 4 MiB). Whitespace is
 * not discounted, so the estimate errs high.
 */
export function decideReadGateFromStats(input: {
  filePath: string;
  lineCount: number;
  bytes: number;
  offset: number | null;
  limit: number | null;
  threshold: number;
}): ReadGate {
  if (!isCodeFile(input.filePath)) return { kind: "pass" };

  return gateFromCounts(input.lineCount, input.bytes, 0, input.offset, input.limit, input.threshold);
}

/**
 * First lines of a gated Read's result: says plainly that the model got the
 * file's outline, not its text, and how to get exact lines.
 */
export function outlineHeader(
  relPath: string,
  lineCount: number,
  estTokens: number,
  prefix: string,
): string {
  return (
    `[token-pilot] ${relPath} has ${lineCount} lines (~${estTokens} tokens). ` +
    `Below is its structural outline, not the file text.\n` +
    `Exact lines: Read with offset/limit · one symbol: ${prefix}read_symbol · ` +
    `before an Edit: ${prefix}read_for_edit.\n\n`
  );
}
