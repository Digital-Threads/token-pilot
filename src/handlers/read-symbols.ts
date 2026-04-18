import { readFile } from "node:fs/promises";
import type { AstIndexClient } from "../ast-index/client.js";
import type { SymbolResolver } from "../core/symbol-resolver.js";
import type { FileCache } from "../core/file-cache.js";
import type { ContextRegistry } from "../core/context-registry.js";
import { estimateTokens } from "../core/token-estimator.js";
import { resolveSafePath } from "../core/validation.js";
import { assessConfidence, formatConfidence } from "../core/confidence.js";

export interface ReadSymbolsArgs {
  path: string;
  symbols: string[];
  context_before?: number;
  context_after?: number;
  show?: "full" | "head" | "tail" | "outline";
}

export async function handleReadSymbols(
  args: ReadSymbolsArgs,
  projectRoot: string,
  symbolResolver: SymbolResolver,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  astIndex?: AstIndexClient,
  advisoryReminders = true,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);

  // Get file content ONCE
  const cached = fileCache.get(absPath);
  let lines: string[];

  if (cached) {
    lines = cached.lines;
  } else {
    const content = await readFile(absPath, "utf-8");
    lines = content.split("\n");
  }

  // Get AST structure ONCE
  let structure = cached?.structure;
  if (!structure && astIndex) {
    structure = (await astIndex.outline(absPath)) ?? undefined;
  }

  const N = args.symbols.length;
  const sections: string[] = [];

  // v0.23.6 — anti-pattern guard. When the caller requests nearly every
  // symbol in the file, the sum of bodies + N × per-symbol metadata
  // exceeds a single raw Read. That's worse than what smart_read +
  // read_for_edit would do. Refuse the request and tell the caller.
  if (structure && structure.symbols && structure.symbols.length > 0) {
    const uniqueRequested = new Set(args.symbols.map((s) => s.split(".")[0]));
    const matchedTopLevel = structure.symbols.filter((s) =>
      uniqueRequested.has(s.name),
    );
    const totalTopLevelLines = structure.symbols.reduce(
      (sum, s) => sum + (s.location.lineCount ?? 0),
      0,
    );
    const requestedLines = matchedTopLevel.reduce(
      (sum, s) => sum + (s.location.lineCount ?? 0),
      0,
    );
    if (
      totalTopLevelLines > 0 &&
      requestedLines / totalTopLevelLines >= 0.7 &&
      matchedTopLevel.length >= 3
    ) {
      const text =
        `FILE: ${args.path} | SYMBOLS: ${N} requested\n\n` +
        `ADVISORY: You requested ${matchedTopLevel.length} symbols covering ` +
        `≥70% of this file (${requestedLines}/${totalTopLevelLines} lines). ` +
        `A batch read here costs more than reading the whole file once.\n\n` +
        `Cheaper alternatives:\n` +
        `  - smart_read("${args.path}") for a structural overview\n` +
        `  - read_for_edit("${args.path}", "<symbol>") when you need exact edit context\n` +
        `  - Raw Read with offset/limit for a specific range\n\n` +
        `If you truly need every body, call read_symbols with a narrower list ` +
        `or use raw Read (bounded).`;
      return { content: [{ type: "text", text }] };
    }
  }

  // Show mode constants (same as read_symbol.ts)
  const MAX_SYMBOL_LINES = 300;
  const MAX_FULL_LINES = 500;
  const HEAD = 50;
  const TAIL = 30;

  let anyTruncated = false;
  let anyResolved = false;
  let totalTokens = 0;

  for (let i = 0; i < N; i++) {
    const symbolName = args.symbols[i];
    const idx = i + 1;

    const resolved = await symbolResolver.resolve(symbolName, structure);

    if (!resolved) {
      sections.push(
        `SYMBOL ${idx}/${N}: ${symbolName}\n` +
          `ERROR: Symbol "${symbolName}" not found in ${args.path}.\n` +
          `HINT: Use smart_read("${args.path}") to see available symbols.`,
      );
      continue;
    }

    anyResolved = true;
    const source = symbolResolver.extractSource(resolved, lines, {
      contextBefore: args.context_before ?? 2,
      contextAfter: args.context_after ?? 0,
    });

    const loc = `[L${resolved.startLine}-${resolved.endLine}]`;
    const lineCount = resolved.endLine - resolved.startLine + 1;

    // Determine effective show mode
    const showMode =
      args.show ?? (lineCount > MAX_SYMBOL_LINES ? "outline" : "full");
    let displaySource = source;
    let truncated = false;

    if (showMode === "full") {
      if (lineCount > MAX_FULL_LINES) {
        const sourceLines = source.split("\n");
        displaySource = sourceLines.slice(0, MAX_FULL_LINES).join("\n");
        displaySource += `\n\n    ... truncated at ${MAX_FULL_LINES} lines (${lineCount - MAX_FULL_LINES} more). Use show="head"/"tail" for targeted view.`;
        truncated = true;
      }
    } else if (showMode === "head") {
      const sourceLines = source.split("\n");
      displaySource = sourceLines.slice(0, HEAD).join("\n");
      if (lineCount > HEAD) {
        displaySource += `\n\n    ... ${lineCount - HEAD} more lines. Use show="tail" or read_symbol("${args.path}", "MethodName") for specific parts.`;
        truncated = true;
      }
    } else if (showMode === "tail") {
      const sourceLines = source.split("\n");
      displaySource = sourceLines.slice(-TAIL).join("\n");
      if (lineCount > TAIL) {
        displaySource =
          `    ... ${lineCount - TAIL} lines above ...\n\n` + displaySource;
        truncated = true;
      }
    } else {
      // 'outline' mode: head + method list + tail
      if (lineCount > HEAD + TAIL) {
        const sourceLines = source.split("\n");
        const head = sourceLines.slice(0, HEAD).join("\n");
        const tail = sourceLines.slice(-TAIL).join("\n");
        const omitted = sourceLines.length - HEAD - TAIL;

        let methodOutline = "";
        if (resolved.symbol.children && resolved.symbol.children.length > 0) {
          const methodLines = resolved.symbol.children.map((c) => {
            const mLoc = `[L${c.location.startLine}-${c.location.endLine}]`;
            return `  ${c.visibility === "private" ? "🔒 " : ""}${c.name}${c.kind === "method" || c.kind === "function" ? "()" : ""} ${mLoc} (${c.location.lineCount} lines)`;
          });
          methodOutline = `\nMETHODS (${resolved.symbol.children.length}):\n${methodLines.join("\n")}\n`;
        }

        displaySource = [
          head,
          "",
          `    ... ${omitted} lines omitted — use read_symbol("${args.path}", "MethodName") to read specific methods ...`,
          methodOutline,
          tail,
        ].join("\n");
        truncated = true;
      }
    }

    if (truncated) anyTruncated = true;

    const symbolLines: string[] = [
      `SYMBOL ${idx}/${N}: ${symbolName} (${resolved.symbol.kind}) ${loc} (${lineCount} lines${truncated ? `, show=${showMode}` : ""})`,
      "",
      displaySource,
    ];

    if (resolved.symbol.references.length > 0) {
      symbolLines.push("");
      symbolLines.push(`REFERENCES: ${resolved.symbol.references.join(", ")}`);
    }

    sections.push(symbolLines.join("\n"));

    // Track each symbol
    const sectionTokens = estimateTokens(symbolLines.join("\n"));
    totalTokens += sectionTokens;
    contextRegistry.trackLoad(absPath, {
      type: "symbol",
      symbolName,
      startLine: resolved.startLine,
      endLine: resolved.endLine,
      tokens: sectionTokens,
    });
  }

  if (cached?.hash) {
    contextRegistry.setContentHash(absPath, cached.hash);
  }

  const header = `FILE: ${args.path} | SYMBOLS: ${N} requested`;
  const body = sections.join("\n\n---\n\n");
  const footer = "CONTEXT TRACKED: These symbols are now in your context.";

  const output = [header, "", body, "", footer].join("\n");

  // Confidence metadata (aggregate)
  const confidenceMeta = assessConfidence({
    symbolResolved: anyResolved,
    truncated: anyTruncated,
    fullFile: false,
    hasCallers: false,
    astAvailable: !!structure,
  });

  return {
    content: [
      { type: "text", text: output + formatConfidence(confidenceMeta) },
    ],
  };
}
