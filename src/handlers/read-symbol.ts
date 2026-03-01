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
}

export async function handleReadSymbol(
  args: ReadSymbolArgs,
  projectRoot: string,
  symbolResolver: SymbolResolver,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  astIndex?: AstIndexClient,
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

  const outputLines: string[] = [
    `FILE: ${args.path}`,
    `SYMBOL: ${args.symbol} (${resolved.symbol.kind}) ${loc} (${lineCount} lines)`,
    '',
    source,
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

  return { content: [{ type: 'text', text: output }] };
}
