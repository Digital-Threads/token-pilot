/**
 * Render a HookSummary into the body of a PreToolUse deny message.
 *
 * The formatted string becomes `hookSpecificOutput.permissionDecisionReason`
 * when the hook decides to block a Read. It is the ONLY output the agent
 * sees for the blocked call, so it carries both the structural summary and
 * the escape-hatch instructions.
 *
 * Kept separate from the hook entry point for unit-testability.
 */

import type { HookSummary, SignalLine } from "./summary-types.js";
import type { PipelineTier } from "./summary-pipeline.js";

export interface FormatOptions {
  filePath: string;
  summary: HookSummary;
  tier: PipelineTier;
  /** Soft cap on the rendered message token count (estimated). Default 1200. */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 1200;

function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 4);
  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / text.length;
  const adjustment = 1 - whitespaceRatio * 0.3;
  return Math.ceil(charEstimate * adjustment);
}

function formatSignalLine(s: SignalLine): string {
  return `L${s.line}: ${s.text}`;
}

function header(opts: FormatOptions): string {
  const { filePath, summary } = opts;
  return (
    `File "${filePath}" has ${summary.totalLines} lines (~${summary.estimatedTokens} tokens).\n` +
    `Read denied to save context; structural summary follows.`
  );
}

function footer(): string {
  return [
    "How to proceed:",
    "- Structural overview (preferred): mcp__token-pilot__smart_read(path).",
    "- For specific lines: Read(path, offset, limit) — bounded reads are passed through.",
    "- For a single symbol: mcp__token-pilot__read_symbol(path, name).",
    "- For edit context: mcp__token-pilot__read_for_edit(path, symbol).",
    "- Full read (expensive): set TOKEN_PILOT_BYPASS=1 for this session.",
  ].join("\n");
}

interface Sections {
  imports: SignalLine[];
  exports: SignalLine[];
  declarations: SignalLine[];
  raws: SignalLine[];
}

function partition(signals: SignalLine[]): Sections {
  const sections: Sections = {
    imports: [],
    exports: [],
    declarations: [],
    raws: [],
  };
  for (const s of signals) {
    if (s.kind === "import") sections.imports.push(s);
    else if (s.kind === "export") sections.exports.push(s);
    else if (s.kind === "raw") sections.raws.push(s);
    else sections.declarations.push(s);
  }
  return sections;
}

function renderSections(
  sections: Sections,
  note: string | undefined,
): { body: string; signalLineCount: number } {
  const lines: string[] = [];
  let signalLineCount = 0;

  if (note) {
    lines.push(`Note: ${note}`);
    lines.push("");
  }

  if (sections.imports.length > 0) {
    lines.push("=== Imports ===");
    sections.imports.forEach((s) => {
      lines.push(formatSignalLine(s));
      signalLineCount++;
    });
    lines.push("");
  }

  if (sections.exports.length > 0) {
    lines.push("=== Exports / Public symbols ===");
    sections.exports.forEach((s) => {
      lines.push(formatSignalLine(s));
      signalLineCount++;
    });
    lines.push("");
  }

  if (sections.declarations.length > 0) {
    lines.push("=== Declarations ===");
    sections.declarations.forEach((s) => {
      lines.push(formatSignalLine(s));
      signalLineCount++;
    });
    lines.push("");
  }

  if (sections.raws.length > 0) {
    lines.push("=== Content preview (head + tail) ===");
    sections.raws.forEach((s) => {
      lines.push(formatSignalLine(s));
      signalLineCount++;
    });
    lines.push("");
  }

  return { body: lines.join("\n"), signalLineCount };
}

export function formatDenyMessage(opts: FormatOptions): string {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Build with full signal list first.
  let sections = partition(opts.summary.signals);
  let { body } = renderSections(sections, opts.summary.note);
  let message = [header(opts), "", body, footer()].join("\n");
  let trimmed = false;

  // If we overflow, drop signals from the END of each section in lockstep
  // until we fit. Keeps the overall signal distribution intact.
  while (estimateTokens(message) > maxTokens) {
    const totalSignals =
      sections.imports.length +
      sections.exports.length +
      sections.declarations.length +
      sections.raws.length;
    if (totalSignals === 0) break;

    // Trim 10 % of remaining signals per pass (minimum 1) to converge quickly.
    const drop = Math.max(1, Math.floor(totalSignals * 0.1));
    let toDrop = drop;
    for (const bucket of [
      "raws",
      "declarations",
      "exports",
      "imports",
    ] as const) {
      while (toDrop > 0 && sections[bucket].length > 0) {
        sections[bucket].pop();
        toDrop--;
      }
      if (toDrop === 0) break;
    }

    trimmed = true;
    ({ body } = renderSections(sections, opts.summary.note));
    message = [header(opts), "", body, footer()].join("\n");
  }

  if (trimmed) {
    const trimmedNote =
      "\n(trimmed to fit budget; call mcp__token-pilot__outline(path) for full structure)";
    message = [
      header(opts),
      "",
      body.trimEnd(),
      trimmedNote,
      "",
      footer(),
    ].join("\n");
  }

  return message;
}
