import type { AstIndexClient } from '../ast-index/client.js';
import type { FindUsagesArgs } from '../core/validation.js';

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extension map for lang filter (best-effort) */
const LANG_EXT_MAP: Record<string, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  php: ['.php'],
  python: ['.py'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  ruby: ['.rb'],
  csharp: ['.cs'],
  kotlin: ['.kt', '.kts'],
  swift: ['.swift'],
  dart: ['.dart'],
  vue: ['.vue'],
  svelte: ['.svelte'],
};

/**
 * Find all usages of a symbol across the project.
 *
 * Strategy: combine ast-index `refs` (structured: definitions + usages)
 * with `search` (text: catches imports and self-references that refs misses).
 * Filter search results to exact word matches only (no substring matches).
 * Deduplicate by file:line.
 *
 * v1.1: added scope, kind, limit, lang post-filters.
 */
export async function handleFindUsages(
  args: FindUsagesArgs,
  astIndex: AstIndexClient,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  meta: { files: string[]; definitions: number; imports: number; usages: number; total: number };
}> {
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [{
        type: 'text',
        text: 'find_usages is disabled: ' + (astIndex.isDisabled()
          ? 'project root not detected. Call smart_read() on any project file first — this auto-detects the project root and enables ast-index tools.'
          : 'ast-index built >50k files (likely includes node_modules). Ensure node_modules is in .gitignore.')
          + '\nAlternative: use grep_search to find symbol references.',
      }],
      meta: { files: [], definitions: 0, imports: 0, usages: 0, total: 0 },
    };
  }

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

  // Build mutable result arrays
  let definitions = refs.definitions.map(d => ({ file: d.path, line: d.line, text: (d.signature ?? d.name).trim() }));
  let allImports = [
    ...refs.imports.map(i => ({ file: i.path, line: i.line, text: (i.context ?? i.name).trim() })),
    ...additionalImports.map(r => ({ file: r.file, line: r.line, text: r.text })),
  ];
  let allUsages = [
    ...refs.usages.map(u => ({ file: u.path, line: u.line, text: (u.context ?? u.name).trim() })),
    ...additionalOther,
  ];

  // ─── Post-filters (v1.1) ───

  // 1. Scope filter — by path prefix
  if (args.scope) {
    const scopePrefix = args.scope;
    definitions = definitions.filter(d => d.file.includes(scopePrefix));
    allImports = allImports.filter(i => i.file.includes(scopePrefix));
    allUsages = allUsages.filter(u => u.file.includes(scopePrefix));
  }

  // 2. Lang filter — best-effort by file extension
  if (args.lang) {
    const langLower = args.lang.toLowerCase();
    const exts = LANG_EXT_MAP[langLower] ?? [`.${langLower}`];
    const matchesLang = (file: string) => exts.some(e => file.endsWith(e));
    definitions = definitions.filter(d => matchesLang(d.file));
    allImports = allImports.filter(i => matchesLang(i.file));
    allUsages = allUsages.filter(u => matchesLang(u.file));
  }

  // 3. Kind filter — select sections
  const kind = args.kind ?? 'all';
  if (kind !== 'all') {
    switch (kind) {
      case 'definitions': allImports = []; allUsages = []; break;
      case 'imports': definitions = []; allUsages = []; break;
      case 'usages': definitions = []; allImports = []; break;
    }
  }

  // 4. Limit — per category
  const limit = args.limit ?? 50;
  definitions = definitions.slice(0, limit);
  allImports = allImports.slice(0, limit);
  allUsages = allUsages.slice(0, limit);

  // ─── Output ───

  const totalCount = definitions.length + allImports.length + allUsages.length;

  if (totalCount === 0) {
    const hints = [`No usages found for "${args.symbol}".`];
    if (args.scope) hints.push(`  (filtered by scope: "${args.scope}")`);
    if (args.lang) hints.push(`  (filtered by lang: "${args.lang}")`);
    if (args.kind && args.kind !== 'all') hints.push(`  (filtered by kind: "${args.kind}")`);
    if (!astIndex.isAvailable()) {
      hints.push('WARNING: ast-index is not available.');
    }
    return {
      content: [{ type: 'text', text: hints.join('\n') }],
      meta: { files: [], definitions: 0, imports: 0, usages: 0, total: 0 },
    };
  }

  // Build header with active filters
  const filterHints: string[] = [];
  if (args.scope) filterHints.push(`scope="${args.scope}"`);
  if (args.lang) filterHints.push(`lang=${args.lang}`);
  if (args.kind && args.kind !== 'all') filterHints.push(`kind=${args.kind}`);
  const filterStr = filterHints.length > 0 ? ` [${filterHints.join(', ')}]` : '';

  const lines: string[] = [
    `REFS: "${args.symbol}" (${totalCount} total: ${definitions.length} definitions, ${allImports.length} imports, ${allUsages.length} usages)${filterStr}`,
    '',
  ];

  if (definitions.length > 0) {
    lines.push('DEFINITIONS:');
    for (const d of definitions) {
      lines.push(`  ${d.file}:${d.line}`);
      lines.push(`    ${d.text}`);
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

  if (allUsages.length > 0) {
    lines.push('USAGES:');
    for (const u of allUsages) {
      lines.push(`  ${u.file}:${u.line}`);
      lines.push(`    ${u.text}`);
    }
    lines.push('');
  }

  lines.push('HINT: Use read_symbol() or read_range() to load specific results.');

  const files = Array.from(new Set([
    ...definitions.map((d) => d.file),
    ...allImports.map((i) => i.file),
    ...allUsages.map((u) => u.file),
  ])).sort();

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    meta: {
      files,
      definitions: definitions.length,
      imports: allImports.length,
      usages: allUsages.length,
      total: totalCount,
    },
  };
}
