import { readFile } from 'node:fs/promises';
import type { AstIndexClient } from '../ast-index/client.js';
import type { SymbolResolver } from '../core/symbol-resolver.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';

export interface ReadSymbolArgs {
  path: string;
  symbol: string;
  context_before?: number;
  context_after?: number;
  show?: 'full' | 'head' | 'tail' | 'outline';
}

export async function handleReadSymbol(
  args: ReadSymbolArgs,
  projectRoot: string,
  symbolResolver: SymbolResolver,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  astIndex?: AstIndexClient,
  advisoryReminders = true,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);

  // Get file content
  const cached = fileCache.get(absPath);
  let lines: string[];

  if (cached) {
    lines = cached.lines;
  } else {
    const content = await readFile(absPath, 'utf-8');
    lines = content.split('\n');
  }

  // Dedup: check if content already in context and unchanged
  if (advisoryReminders) {
    const hash = cached?.hash;
    if (hash && !contextRegistry.isStale(absPath, hash)) {
      if (contextRegistry.isFullyLoaded(absPath) || contextRegistry.isSymbolLoaded(absPath, args.symbol)) {
        const reminder = contextRegistry.symbolReminder(absPath, args.symbol);
        if (reminder) {
          return { content: [{ type: 'text', text: reminder }] };
        }
      }
    }
  }

  // Resolve symbol — auto-fetch structure if not cached
  let structure = cached?.structure;
  if (!structure && astIndex) {
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

  // Extract source
  const source = symbolResolver.extractSource(resolved, lines, {
    contextBefore: args.context_before ?? 2,
    contextAfter: args.context_after ?? 0,
  });

  const loc = `[L${resolved.startLine}-${resolved.endLine}]`;
  const lineCount = resolved.endLine - resolved.startLine + 1;

  // Show mode: control how large symbols are displayed
  const MAX_SYMBOL_LINES = 300;
  const MAX_FULL_LINES = 500;
  const HEAD = 50;
  const TAIL = 30;
  let displaySource = source;
  let truncated = false;

  // Determine effective show mode
  const showMode = args.show ?? (lineCount > MAX_SYMBOL_LINES ? 'outline' : 'full');

  if (showMode === 'full') {
    if (lineCount > MAX_FULL_LINES) {
      const sourceLines = source.split('\n');
      displaySource = sourceLines.slice(0, MAX_FULL_LINES).join('\n');
      displaySource += `\n\n    ... truncated at ${MAX_FULL_LINES} lines (${lineCount - MAX_FULL_LINES} more). Use show="head"/"tail" for targeted view.`;
      truncated = true;
    }
  } else if (showMode === 'head') {
    const sourceLines = source.split('\n');
    displaySource = sourceLines.slice(0, HEAD).join('\n');
    if (lineCount > HEAD) {
      displaySource += `\n\n    ... ${lineCount - HEAD} more lines. Use show="tail" or read_symbol("${args.path}", "MethodName") for specific parts.`;
      truncated = true;
    }
  } else if (showMode === 'tail') {
    const sourceLines = source.split('\n');
    displaySource = sourceLines.slice(-TAIL).join('\n');
    if (lineCount > TAIL) {
      displaySource = `    ... ${lineCount - TAIL} lines above ...\n\n` + displaySource;
      truncated = true;
    }
  } else {
    // 'outline' mode: head + method list + tail
    if (lineCount > HEAD + TAIL) {
      const sourceLines = source.split('\n');
      const head = sourceLines.slice(0, HEAD).join('\n');
      const tail = sourceLines.slice(-TAIL).join('\n');
      const omitted = sourceLines.length - HEAD - TAIL;

      let methodOutline = '';
      if (resolved.symbol.children && resolved.symbol.children.length > 0) {
        const methodLines = resolved.symbol.children.map(c => {
          const mLoc = `[L${c.location.startLine}-${c.location.endLine}]`;
          return `  ${c.visibility === 'private' ? '🔒 ' : ''}${c.name}${c.kind === 'method' || c.kind === 'function' ? '()' : ''} ${mLoc} (${c.location.lineCount} lines)`;
        });
        methodOutline = `\nMETHODS (${resolved.symbol.children.length}):\n${methodLines.join('\n')}\n`;
      }

      displaySource = [
        head,
        '',
        `    ... ${omitted} lines omitted — use read_symbol("${args.path}", "MethodName") to read specific methods ...`,
        methodOutline,
        tail,
      ].join('\n');
      truncated = true;
    }
  }

  const outputLines: string[] = [
    `FILE: ${args.path}`,
    `SYMBOL: ${args.symbol} (${resolved.symbol.kind}) ${loc} (${lineCount} lines${truncated ? `, show=${showMode}` : ''})`,
    '',
    displaySource,
  ];

  // References
  if (resolved.symbol.references.length > 0) {
    outputLines.push('');
    outputLines.push(`REFERENCES: ${resolved.symbol.references.join(', ')}`);
  }

  // Build full output including tracking message, THEN estimate tokens
  outputLines.push('');
  outputLines.push('CONTEXT TRACKED: This symbol is now in your context.');

  const output = outputLines.join('\n');
  const tokens = estimateTokens(output);

  // Track
  contextRegistry.trackLoad(absPath, {
    type: 'symbol',
    symbolName: args.symbol,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
    tokens,
  });
  if (cached?.hash) {
    contextRegistry.setContentHash(absPath, cached.hash);
  }

  return { content: [{ type: 'text', text: output }] };
}
