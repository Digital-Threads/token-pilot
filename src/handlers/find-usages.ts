import type { AstIndexClient } from '../ast-index/client.js';

export interface FindUsagesArgs {
  symbol: string;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find all usages of a symbol across the project.
 *
 * Strategy: combine ast-index `refs` (structured: definitions + usages)
 * with `search` (text: catches imports and self-references that refs misses).
 * Filter search results to exact word matches only (no substring matches).
 * Deduplicate by file:line.
 */
export async function handleFindUsages(
  args: FindUsagesArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Run refs + search in parallel
  const [refs, searchResults] = await Promise.all([
    astIndex.refs(args.symbol),
    astIndex.search(args.symbol),
  ]);

  // Build dedup set from refs
  const seen = new Set<string>();
  for (const d of refs.definitions) seen.add(`${d.path}:${d.line}`);
  for (const i of refs.imports) seen.add(`${i.path}:${i.line}`);
  for (const u of refs.usages) seen.add(`${u.path}:${u.line}`);

  // Filter search results: exact word match only, not already in refs
  const wordBoundary = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegex(args.symbol)}(?![a-zA-Z0-9_])`);
  const additional: Array<{ file: string; line: number; text: string }> = [];

  for (const r of searchResults) {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) continue;
    if (!wordBoundary.test(r.text)) continue;
    seen.add(key);
    additional.push(r);
  }

  // Categorize additional results
  const additionalImports = additional.filter(r =>
    /\bimport\b/.test(r.text),
  );
  const additionalOther = additional.filter(r =>
    !/\bimport\b/.test(r.text),
  );

  // Merge imports: refs.imports + additional imports
  const allImports = [
    ...refs.imports.map(i => ({ file: i.path, line: i.line, text: (i.context ?? i.name).trim() })),
    ...additionalImports.map(r => ({ file: r.file, line: r.line, text: r.text })),
  ];

  // Total count
  const totalCount = refs.definitions.length + allImports.length + refs.usages.length + additionalOther.length;

  if (totalCount === 0) {
    const hints = [`No usages found for "${args.symbol}".`];
    if (!astIndex.isAvailable()) {
      hints.push('WARNING: ast-index is not available.');
    }
    return { content: [{ type: 'text', text: hints.join('\n') }] };
  }

  const lines: string[] = [
    `REFS: "${args.symbol}" (${totalCount} total: ${refs.definitions.length} definitions, ${allImports.length} imports, ${refs.usages.length + additionalOther.length} usages)`,
    '',
  ];

  if (refs.definitions.length > 0) {
    lines.push('DEFINITIONS:');
    for (const d of refs.definitions) {
      lines.push(`  ${d.path}:${d.line}`);
      lines.push(`    ${(d.signature ?? d.name).trim()}`);
    }
    lines.push('');
  }

  if (allImports.length > 0) {
    lines.push('IMPORTS:');
    for (const i of allImports) {
      lines.push(`  ${i.file}:${i.line}`);
      lines.push(`    ${i.text}`);
    }
    lines.push('');
  }

  const allUsages = [
    ...refs.usages.map(u => ({ file: u.path, line: u.line, text: (u.context ?? u.name).trim() })),
    ...additionalOther,
  ];

  if (allUsages.length > 0) {
    lines.push('USAGES:');
    for (const u of allUsages) {
      lines.push(`  ${u.file}:${u.line}`);
      lines.push(`    ${u.text}`);
    }
    lines.push('');
  }

  lines.push('HINT: Use read_symbol() or read_range() to load specific results.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
