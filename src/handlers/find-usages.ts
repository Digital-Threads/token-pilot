import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { FindUsagesArgs } from '../core/validation.js';
import { assessConfidence, formatConfidence } from '../core/confidence.js';

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
 * Render a section (DEFINITIONS/IMPORTS/USAGES) grouped by file.
 * Single match per file → one line. Multiple → file header + indented lines.
 */
function renderSection(
  title: string,
  items: Array<{ file: string; line: number; text: string }>,
): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [`${title}:`];

  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const item of items) {
    const arr = byFile.get(item.file) ?? [];
    arr.push({ line: item.line, text: item.text });
    byFile.set(item.file, arr);
  }

  for (const [file, matches] of byFile) {
    matches.sort((a, b) => a.line - b.line);
    if (matches.length === 1) {
      lines.push(`  ${file}:${matches[0].line}  ${matches[0].text}`);
    } else {
      lines.push(`  ${file}:`);
      for (const m of matches) {
        lines.push(`    :${m.line}  ${m.text}`);
      }
    }
  }

  lines.push('');
  return lines;
}

/** Max unique files to read for context (prevents unbounded I/O). */
const MAX_CONTEXT_FILES = 30;

/** Max file size (bytes) to read for context lines. */
const MAX_CONTEXT_FILE_SIZE = 500_000;

/**
 * Render a section with surrounding source context lines.
 * Uses shared fileCache to avoid re-reading the same file across sections.
 */
async function renderSectionWithContext(
  title: string,
  items: Array<{ file: string; line: number; text: string }>,
  contextLines: number,
  projectRoot: string,
  fileCache: Map<string, string[] | null>,
): Promise<string[]> {
  if (items.length === 0) return [];
  const lines: string[] = [`${title}:`];

  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const item of items) {
    const arr = byFile.get(item.file) ?? [];
    arr.push({ line: item.line, text: item.text });
    byFile.set(item.file, arr);
  }

  let filesRead = 0;
  for (const [file, matches] of byFile) {
    matches.sort((a, b) => a.line - b.line);
    lines.push(`  ${file}:`);

    // Read file for context (with shared cache and limits)
    let fileLines: string[] | null = null;
    if (fileCache.has(file)) {
      fileLines = fileCache.get(file)!;
    } else if (filesRead < MAX_CONTEXT_FILES) {
      try {
        const { stat } = await import('node:fs/promises');
        const fileStat = await stat(resolve(projectRoot, file));
        if (fileStat.size <= MAX_CONTEXT_FILE_SIZE) {
          const content = await readFile(resolve(projectRoot, file), 'utf-8');
          fileLines = content.split('\n');
        }
      } catch {
        // File unreadable
      }
      fileCache.set(file, fileLines);
      filesRead++;
    }

    if (!fileLines) {
      for (const m of matches) {
        lines.push(`    :${m.line}  ${m.text}`);
      }
      continue;
    }

    for (let mi = 0; mi < matches.length; mi++) {
      const m = matches[mi];
      const start = Math.max(0, m.line - 1 - contextLines);
      const end = Math.min(fileLines.length, m.line + contextLines);
      for (let i = start; i < end; i++) {
        const lineNum = i + 1;
        const marker = lineNum === m.line ? '>' : ' ';
        lines.push(`    ${marker} ${lineNum} | ${fileLines[i]}`);
      }
      if (mi < matches.length - 1) {
        lines.push('');
      }
    }
  }

  lines.push('');
  return lines;
}

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
  projectRoot?: string,
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
          + '\nAlternative: use Grep to find symbol references.',
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

  // ─── List mode — compact file:line output ───
  if (args.mode === 'list') {
    const allItems = [...definitions, ...allImports, ...allUsages];
    const byFile = new Map<string, number[]>();
    for (const item of allItems) {
      const arr = byFile.get(item.file) ?? [];
      arr.push(item.line);
      byFile.set(item.file, arr);
    }

    const listLines: string[] = [
      `USAGES OF "${args.symbol}" (${allItems.length} matches in ${byFile.size} files):`,
      '',
    ];

    for (const [file, fileLines] of byFile) {
      const sorted = [...new Set(fileLines)].sort((a, b) => a - b);
      listLines.push(`  ${file}: L${sorted.join(', L')}`);
    }

    listLines.push('');
    listLines.push(`HINT: Use find_usages("${args.symbol}", path="specific_dir/") to narrow, or read_symbol() on specific matches.`);

    return {
      content: [{ type: 'text', text: listLines.join('\n') }],
      meta: {
        files: Array.from(byFile.keys()),
        definitions: definitions.length,
        imports: allImports.length,
        usages: allUsages.length,
        total: allItems.length,
      },
    };
  }

  // Build header with active filters
  const filterHints: string[] = [];
  if (args.scope) filterHints.push(`scope="${args.scope}"`);
  if (args.lang) filterHints.push(`lang=${args.lang}`);
  if (args.kind && args.kind !== 'all') filterHints.push(`kind=${args.kind}`);
  const filterStr = filterHints.length > 0 ? ` [${filterHints.join(', ')}]` : '';

  const lines: string[] = [
    `REFS: "${args.symbol}" (${totalCount} total: ${definitions.length} def · ${allImports.length} imports · ${allUsages.length} usages)${filterStr}`,
    '',
  ];

  if (args.context_lines !== undefined && args.context_lines > 0 && projectRoot) {
    // Shared file cache across all three sections to avoid re-reading the same files
    const contextFileCache = new Map<string, string[] | null>();
    const [defSection, impSection, useSection] = await Promise.all([
      renderSectionWithContext('DEFINITIONS', definitions, args.context_lines, projectRoot, contextFileCache),
      renderSectionWithContext('IMPORTS', allImports, args.context_lines, projectRoot, contextFileCache),
      renderSectionWithContext('USAGES', allUsages, args.context_lines, projectRoot, contextFileCache),
    ]);
    lines.push(...defSection);
    lines.push(...impSection);
    lines.push(...useSection);
  } else {
    lines.push(...renderSection('DEFINITIONS', definitions));
    lines.push(...renderSection('IMPORTS', allImports));
    lines.push(...renderSection('USAGES', allUsages));
  }

  lines.push('HINT: Use read_symbol() or read_range() to load specific results.');

  if (totalCount > 20) {
    lines.push('');
    lines.push(`NARROW: ${totalCount} matches found. Use find_usages("${args.symbol}", path="specific_dir/") to filter by location.`);
  }

  // Confidence metadata
  const confidenceMeta = assessConfidence({
    refsFound: totalCount > 0,
    astAvailable: astIndex.isAvailable(),
    symbolResolved: definitions.length > 0,
  });
  lines.push(formatConfidence(confidenceMeta));

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
