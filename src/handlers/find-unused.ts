import type { AstIndexClient } from '../ast-index/client.js';
import type { SymbolInfo } from '../types.js';

export interface FindUnusedArgs {
  module?: string;
  export_only?: boolean;
  limit?: number;
}

/**
 * Universal constructor detection — works across all languages.
 * These are names that every language uses for constructors/destructors.
 * NOT framework-specific — these are language-level concepts.
 */
function isConstructor(name: string): boolean {
  return name === 'constructor' || name === '__init__' || name === '__new__' || name === '__del__';
}

/**
 * Python protocol methods (__str__, __eq__, etc.) — called by the language runtime,
 * never directly by user code. ast-index refs won't find callers.
 */
function isDunderMethod(name: string): boolean {
  return /^__\w+__$/.test(name);
}

export async function handleFindUnused(
  args: FindUnusedArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return { content: [{ type: 'text', text:
      'find_unused is disabled: ' + (astIndex.isDisabled()
        ? 'project root is too broad (e.g. /). Configure mcpServers with "args": ["/path/to/project"].'
        : 'ast-index built >50k files (likely includes node_modules). Ensure node_modules is in .gitignore.') +
      '\nAlternative: use grep_search to find unused exports manually.' }] };
  }

  const requestLimit = (args.limit ?? 30) + 20; // extra to compensate for filtering
  const unused = await astIndex.unusedSymbols({
    module: args.module,
    exportOnly: args.export_only,
    limit: requestLimit,
  });

  // Step 1: Filter out constructors and dunder methods (language-level, universal)
  const afterLangFilter = unused.filter(sym =>
    !isConstructor(sym.name) && !isDunderMethod(sym.name),
  );
  const langExcluded = unused.length - afterLangFilter.length;

  // Step 2: Batch-fetch outlines to get decorator info for remaining symbols
  const uniqueFiles = [...new Set(afterLangFilter.map(s => s.path))];
  const outlineCache = new Map<string, SymbolInfo[]>();

  // Fetch outlines in parallel (max 10 concurrent)
  const batchSize = 10;
  for (let i = 0; i < uniqueFiles.length; i += batchSize) {
    const batch = uniqueFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const outline = await astIndex.outline(file);
          return { file, symbols: outline?.symbols ?? [] };
        } catch {
          return { file, symbols: [] };
        }
      }),
    );
    for (const { file, symbols } of results) {
      outlineCache.set(file, symbols);
    }
  }

  // Step 3: Enrich each unused symbol with decorator info
  interface EnrichedSymbol {
    name: string;
    kind: string;
    line: number;
    path: string;
    signature?: string;
    decorators: string[];
  }

  const enriched: EnrichedSymbol[] = afterLangFilter.map(sym => {
    const fileSymbols = outlineCache.get(sym.path) ?? [];
    const decorators = findSymbolDecorators(sym.name, sym.line, fileSymbols);
    return { ...sym, decorators };
  });

  // Step 4: Separate into decorated (likely framework-invoked) and truly unused
  const decorated = enriched.filter(s => s.decorators.length > 0);
  const trulyUnused = enriched.filter(s => s.decorators.length === 0);

  const trimmed = trulyUnused.slice(0, args.limit ?? 30);

  if (trimmed.length === 0 && decorated.length === 0) {
    const excluded = langExcluded;
    return {
      content: [{
        type: 'text',
        text: args.module
          ? `No unused symbols found in module "${args.module}".${excluded > 0 ? ` (${excluded} constructors/protocol methods excluded)` : ''}`
          : `No unused symbols found in the project.${excluded > 0 ? ` (${excluded} constructors/protocol methods excluded)` : ''}`,
      }],
    };
  }

  const lines: string[] = [];

  // Truly unused (no decorators — likely real dead code)
  if (trimmed.length > 0) {
    lines.push(`UNUSED SYMBOLS: ${trimmed.length} potentially dead code`);
    lines.push('');

    const byFile = groupByFile(trimmed);
    for (const [file, symbols] of byFile) {
      lines.push(`  ${file}:`);
      for (const s of symbols) {
        lines.push(`    ${s.kind} ${s.name} (L${s.line})`);
      }
    }
    lines.push('');
  }

  // Decorated (might be framework-invoked — show separately for awareness)
  if (decorated.length > 0) {
    lines.push(`DECORATED (${decorated.length} — likely framework-invoked, verify manually):`);

    const byFile = groupByFile(decorated);
    for (const [file, symbols] of byFile) {
      lines.push(`  ${file}:`);
      for (const s of symbols) {
        const decs = s.decorators.map(d => `@${d}`).join(' ');
        lines.push(`    ${s.kind} ${s.name} (L${s.line})  ${decs}`);
      }
    }
    lines.push('');
  }

  if (langExcluded > 0) {
    lines.push(`(${langExcluded} constructors/protocol methods excluded)`);
  }
  lines.push('NOTE: Verify before removing — symbols may be used dynamically, in tests, or via framework conventions.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Find decorators for a symbol by matching name + line in the outline tree.
 */
function findSymbolDecorators(name: string, line: number, symbols: SymbolInfo[]): string[] {
  for (const sym of symbols) {
    if (sym.name === name && sym.location.startLine <= line && sym.location.endLine >= line) {
      return sym.decorators ?? [];
    }
    // Check children (methods inside classes)
    if (sym.children) {
      const childResult = findSymbolDecorators(name, line, sym.children);
      if (childResult.length > 0) return childResult;
    }
  }
  return [];
}

function groupByFile<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const existing = byFile.get(item.path) ?? [];
    existing.push(item);
    byFile.set(item.path, existing);
  }
  return byFile;
}
