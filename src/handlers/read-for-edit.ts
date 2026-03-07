import { readFile } from 'node:fs/promises';
import type { AstIndexClient } from '../ast-index/client.js';
import type { SymbolResolver } from '../core/symbol-resolver.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';

export interface ReadForEditArgs {
  path: string;
  symbol?: string;
  line?: number;
  context?: number;
}

const DEFAULT_CONTEXT = 5;

export async function handleReadForEdit(
  args: ReadForEditArgs,
  projectRoot: string,
  symbolResolver: SymbolResolver,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);
  const ctx = args.context ?? DEFAULT_CONTEXT;

  // Get file content
  const cached = fileCache.get(absPath);
  let lines: string[];

  if (cached) {
    lines = cached.lines;
  } else {
    const content = await readFile(absPath, 'utf-8');
    lines = content.split('\n');
  }

  let startLine: number;
  let endLine: number;
  let targetLabel: string;

  if (args.symbol) {
    // Resolve symbol via AST
    let structure = cached?.structure;
    if (!structure) {
      structure = await astIndex.outline(absPath) ?? undefined;
    }
    const resolved = await symbolResolver.resolve(args.symbol, structure);

    if (!resolved) {
      return {
        content: [{
          type: 'text',
          text: `Symbol "${args.symbol}" not found in ${args.path}.\nHINT: Use smart_read("${args.path}") to see available symbols.`,
        }],
      };
    }

    const symbolLines = resolved.endLine - resolved.startLine + 1;
    const MAX_EDIT_LINES = 60;

    startLine = resolved.startLine;

    if (symbolLines <= MAX_EDIT_LINES) {
      endLine = resolved.endLine;
      targetLabel = `${args.symbol} [L${startLine}-${endLine}] (${symbolLines} lines, full)`;
    } else {
      endLine = startLine + MAX_EDIT_LINES - 1;
      targetLabel = `${args.symbol} [L${startLine}-${resolved.endLine}] (showing first ${MAX_EDIT_LINES} of ${symbolLines} lines)`;
    }
  } else if (args.line) {
    if (args.line < 1 || args.line > lines.length) {
      return {
        content: [{
          type: 'text',
          text: `Line ${args.line} out of range (file has ${lines.length} lines).`,
        }],
      };
    }
    startLine = args.line;
    endLine = args.line;
    targetLabel = `line ${args.line}`;
  } else {
    return {
      content: [{
        type: 'text',
        text: 'Either "symbol" or "line" must be provided.',
      }],
    };
  }

  // Apply context padding
  const rangeStart = Math.max(1, startLine - ctx);
  const rangeEnd = Math.min(lines.length, endLine + ctx);
  const rangeCount = rangeEnd - rangeStart + 1;

  // Extract RAW code (no line number prefixes — ready for Edit old_string)
  const rawCode = lines.slice(rangeStart - 1, rangeEnd).join('\n');

  const output = [
    `--- EDIT CONTEXT ---`,
    `FILE: ${args.path}`,
    `TARGET: ${targetLabel}`,
    `SHOWING: L${rangeStart}-${rangeEnd} (${rangeCount} lines)`,
    '',
    rawCode,
    '',
    `--- END EDIT CONTEXT ---`,
    '',
    `To edit: use exact text above as old_string in Edit tool.`,
    `For Read requirement: Read("${args.path}", offset=${rangeStart}, limit=${rangeCount})`,
  ].join('\n');

  const tokens = estimateTokens(output);

  // Track in context
  contextRegistry.trackLoad(absPath, {
    type: 'symbol',
    symbolName: args.symbol ?? `line:${args.line}`,
    startLine: rangeStart,
    endLine: rangeEnd,
    tokens,
  });

  return { content: [{ type: 'text', text: output }] };
}
