import type { AstIndexClient } from '../ast-index/client.js';
import type { FileCache } from '../core/file-cache.js';

export interface ExportAstIndexArgs {
  paths?: string[];
  format?: 'markdown' | 'json';
}

/**
 * Export AST structural data in a format suitable for context-mode's BM25 index.
 *
 * Generates a markdown document with headings per file and symbols as sections,
 * which context-mode can index via its `index` tool for cross-tool search.
 */
export async function handleExportAstIndex(
  args: ExportAstIndexArgs,
  astIndex: AstIndexClient,
  fileCache: FileCache,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const format = args.format ?? 'markdown';

  // Gather all cached files or specified subset
  const cachedPaths = fileCache.cachedPaths();
  const targetPaths = args.paths && args.paths.length > 0
    ? args.paths.filter(p => cachedPaths.includes(p))
    : cachedPaths;

  if (targetPaths.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No indexed files available. Use smart_read on files first to populate the cache.',
      }],
    };
  }

  if (format === 'json') {
    return exportJson(targetPaths, fileCache);
  }

  return exportMarkdown(targetPaths, fileCache);
}

function exportMarkdown(
  paths: string[],
  fileCache: FileCache,
): { content: Array<{ type: 'text'; text: string }> } {
  const sections: string[] = [
    '# Token Pilot AST Index Export',
    '',
    `Exported ${paths.length} files. Index this content via context-mode for cross-tool search.`,
    '',
  ];

  for (const filePath of paths) {
    const cached = fileCache.get(filePath);
    if (!cached) continue;

    const { structure } = cached;
    sections.push(`## ${structure.path}`);
    sections.push('');
    sections.push(`Language: ${structure.language} | Lines: ${structure.meta.lines}`);
    sections.push('');

    // Imports as a section
    if (structure.imports.length > 0) {
      sections.push('### Imports');
      for (const imp of structure.imports) {
        sections.push(`- \`${imp.specifiers.join(', ')}\` from \`${imp.source}\``);
      }
      sections.push('');
    }

    // Symbols as searchable sections
    for (const sym of structure.symbols) {
      formatSymbolMarkdown(sym, sections, 3);
    }

    sections.push('---');
    sections.push('');
  }

  sections.push('');
  sections.push('To index in context-mode, pass this content to the `index` tool with source: "token-pilot-ast".');

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

function exportJson(
  paths: string[],
  fileCache: FileCache,
): { content: Array<{ type: 'text'; text: string }> } {
  const data: Array<{
    path: string;
    language: string;
    lines: number;
    symbols: Array<{ name: string; kind: string; signature: string; location: string }>;
  }> = [];

  for (const filePath of paths) {
    const cached = fileCache.get(filePath);
    if (!cached) continue;

    const symbols = flattenSymbols(cached.structure.symbols);
    data.push({
      path: cached.structure.path,
      language: cached.structure.language,
      lines: cached.structure.meta.lines,
      symbols,
    });
  }

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function formatSymbolMarkdown(
  sym: { name: string; kind: string; signature: string; location: { startLine: number; endLine: number }; children: any[]; doc: string | null },
  sections: string[],
  headingLevel: number,
): void {
  const heading = '#'.repeat(Math.min(headingLevel, 6));
  sections.push(`${heading} ${sym.kind} \`${sym.name}\``);
  sections.push('');
  sections.push(`Signature: \`${sym.signature}\` (L${sym.location.startLine}-${sym.location.endLine})`);

  if (sym.doc) {
    sections.push('');
    sections.push(sym.doc);
  }

  sections.push('');

  for (const child of sym.children) {
    formatSymbolMarkdown(child, sections, headingLevel + 1);
  }
}

function flattenSymbols(
  symbols: Array<{ name: string; kind: string; signature: string; location: { startLine: number; endLine: number }; children: any[] }>,
): Array<{ name: string; kind: string; signature: string; location: string }> {
  const result: Array<{ name: string; kind: string; signature: string; location: string }> = [];

  for (const sym of symbols) {
    result.push({
      name: sym.name,
      kind: sym.kind,
      signature: sym.signature,
      location: `L${sym.location.startLine}-${sym.location.endLine}`,
    });
    if (sym.children.length > 0) {
      result.push(...flattenSymbols(sym.children));
    }
  }

  return result;
}
