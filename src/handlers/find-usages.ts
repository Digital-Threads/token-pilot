import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
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

/** Results asked from ast-index per section — the validator's max `limit`. */
const FETCH_LIMIT = 500;

/** Short language names accepted by `lang`. */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  cs: 'csharp',
  kt: 'kotlin',
  golang: 'go',
};

/** A whole-line comment: `//`, `/*`, `*`, `# ` or `<!--`. */
function isCommentLine(text: string): boolean {
  return /^(\/\/|\/\*|\*\/?(\s|$)|#(\s|$)|<!--)/.test(text.trim());
}

/** `export { x } from '…'` / `export * from '…'` — a re-export is an import. */
const REEXPORT = /^\s*export\s+(type\s+)?(\{[^}]*\}|\*(\s+as\s+[\w$]+)?)\s*from\b/;

/** A bare list member (`user,`, `type User,`, `user as u,`). */
const LIST_MEMBER = /^(type\s+)?[\w$]+(\s+as\s+[\w$]+)?,?$/;

/** `./src/a/` → `src/a`; an absolute path under the root becomes relative. */
function normalizeScope(scope: string, projectRoot?: string): string {
  let s = scope.replace(/\\/g, '/');
  if (projectRoot && isAbsolute(s)) s = relative(projectRoot, s).replace(/\\/g, '/');
  return s.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function inScope(file: string, scope: string): boolean {
  return scope === '' || scope === '.' || file === scope || file.startsWith(scope + '/');
}

async function readLines(
  file: string,
  projectRoot: string,
  fileCache: Map<string, string[] | null>,
): Promise<string[] | null> {
  if (fileCache.has(file)) return fileCache.get(file)!;
  let lines: string[] | null = null;
  try {
    const abs = resolve(projectRoot, file);
    if ((await stat(abs)).size <= MAX_CONTEXT_FILE_SIZE) {
      lines = (await readFile(abs, 'utf-8')).split('\n');
    }
  } catch {
    // unreadable
  }
  fileCache.set(file, lines);
  return lines;
}

/**
 * True when line `line` (1-based) is a member of a multi-line
 * `import {…}` / `export {…} from` list or a Python `from x import (…)`.
 */
async function insideImportList(
  file: string,
  line: number,
  projectRoot: string,
  fileCache: Map<string, string[] | null>,
): Promise<boolean> {
  const lines = await readLines(file, projectRoot, fileCache);
  if (!lines) return false;

  for (let i = line - 2; i >= Math.max(0, line - 51); i--) {
    const l = lines[i];
    if (l.includes('{')) return /^\s*(import|export)\b/.test(l);
    if (l.includes('(')) return /^\s*from\s+\S+\s+import\b/.test(l);
    if (l.includes('}') || l.includes(')') || l.trim().endsWith(';')) return false;
  }

  return false;
}

/**
 * Find all usages of a symbol across the project.
 *
 * Strategy: combine ast-index `refs` (structured: definitions + usages)
 * with `search` (text: catches imports and self-references that refs misses).
 * Filter search results to exact word matches only (no substring matches).
 * Deduplicate by file:line. Every filter (scope, lang, kind) runs before the
 * per-category `limit`, and the output says what the limit or ast-index's
 * own cap left out.
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

  const [refs, searchResults] = await Promise.all([
    astIndex.refs(args.symbol, FETCH_LIMIT),
    astIndex.search(args.symbol, { maxResults: FETCH_LIMIT }),
  ]);
  const binaryCapped = !!refs.truncated || !!searchResults.truncated;

  // refs matches names by prefix (`handleFind` → handleFindUsages): exact only.
  const exact = (e: { name?: string }) => !e.name || e.name === args.symbol;
  const refDefs = refs.definitions.filter(exact);
  const refImports = refs.imports.filter(exact);
  const refUsages = refs.usages.filter(exact);

  const seen = new Set<string>();
  for (const e of [...refDefs, ...refImports, ...refUsages]) seen.add(`${e.path}:${e.line}`);

  // Search results: exact word match only, not already in refs
  const wordBoundary = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegex(args.symbol)}(?![a-zA-Z0-9_])`);
  const additional: Array<{ file: string; line: number; text: string }> = [];
  for (const r of searchResults) {
    const key = `${r.file}:${r.line}`;
    // a file whose name matches is not a usage
    if (r.kind === 'file' || seen.has(key) || !wordBoundary.test(r.text)) continue;
    seen.add(key);
    additional.push(r);
  }

  let definitions = refDefs.map(d => ({ file: d.path, line: d.line, text: (d.signature ?? d.name).trim() }));
  let allImports = refImports.map(i => ({ file: i.path, line: i.line, text: (i.context ?? i.name).trim() }));
  let allUsages: Array<{ file: string; line: number; text: string }> = [];
  const symbolResolved = definitions.length > 0;

  // Classify the rest: comments are counted, not listed; re-exports and
  // members of multi-line import lists are imports.
  const fileCache = new Map<string, string[] | null>();
  let comments: Array<{ file: string }> = [];
  const candidates = [
    ...refUsages.map(u => ({ file: u.path, line: u.line, text: (u.context ?? u.name).trim() })),
    ...additional,
  ];
  for (const r of candidates) {
    if (isCommentLine(r.text)) {
      comments.push(r);
      continue;
    }
    const isImport =
      /\bimport\b/.test(r.text) ||
      REEXPORT.test(r.text) ||
      (!!projectRoot && LIST_MEMBER.test(r.text.trim()) &&
        await insideImportList(r.file, r.line, projectRoot, fileCache));
    (isImport ? allImports : allUsages).push(r);
  }

  // ─── Filters — all before the limit ───

  if (args.scope) {
    const scope = normalizeScope(args.scope, projectRoot);
    definitions = definitions.filter(d => inScope(d.file, scope));
    allImports = allImports.filter(i => inScope(i.file, scope));
    allUsages = allUsages.filter(u => inScope(u.file, scope));
    comments = comments.filter(c => inScope(c.file, scope));
  }

  if (args.lang) {
    const langLower = LANG_ALIASES[args.lang.toLowerCase()] ?? args.lang.toLowerCase();
    const exts = LANG_EXT_MAP[langLower] ?? [`.${langLower}`];
    const matchesLang = (file: string) => exts.some(e => file.endsWith(e));
    definitions = definitions.filter(d => matchesLang(d.file));
    allImports = allImports.filter(i => matchesLang(i.file));
    allUsages = allUsages.filter(u => matchesLang(u.file));
    comments = comments.filter(c => matchesLang(c.file));
  }

  const kind = args.kind ?? 'all';
  if (kind !== 'all') {
    switch (kind) {
      case 'definitions': allImports = []; allUsages = []; comments = []; break;
      case 'imports': definitions = []; allUsages = []; comments = []; break;
      case 'usages': definitions = []; allImports = []; break;
    }
  }

  // ─── Limit — per category, after every filter ───

  const limit = args.limit ?? 50;
  const cut: string[] = [];
  const cap = <T>(items: T[], label: string): T[] => {
    if (items.length > limit) cut.push(`${limit} of ${items.length} ${label}`);
    return items.slice(0, limit);
  };
  definitions = cap(definitions, 'definitions');
  allImports = cap(allImports, 'imports');
  allUsages = cap(allUsages, 'usages');

  const notes: string[] = [];
  if (cut.length > 0) {
    notes.push(`TRUNCATED: showing ${cut.join(', ')} (limit=${limit}) — narrow with scope= or raise limit (max 500).`);
  }
  if (binaryCapped) {
    notes.push(`ast-index returned its cap of ${FETCH_LIMIT} results for a section — more may exist.`);
  }
  if (comments.length > 0) {
    notes.push(`${comments.length} mention${comments.length === 1 ? '' : 's'} in comments not listed.`);
  }
  const stale = astIndex.isStale?.() ?? false;
  if (stale) {
    notes.push('ast-index could not refresh — the index may be stale: files created or edited in the last minutes may be missing.');
  }

  // ─── Output ───

  const totalCount = definitions.length + allImports.length + allUsages.length;

  if (totalCount === 0) {
    const hints = [`No usages found for "${args.symbol}".`];
    if (args.scope) hints.push(`  (filtered by scope: "${args.scope}")`);
    if (args.lang) hints.push(`  (filtered by lang: "${args.lang}")`);
    if (args.kind && args.kind !== 'all') hints.push(`  (filtered by kind: "${args.kind}")`);
    hints.push(...notes);
    hints.push('(ast-index does not index dot-directories such as .github/ — Grep there if it matters.)');
    if (!astIndex.isAvailable()) {
      hints.push('WARNING: ast-index is not available.');
    }
    return {
      content: [{ type: 'text', text: hints.join('\n') }],
      meta: { files: [], definitions: 0, imports: 0, usages: 0, total: 0 },
    };
  }

  const narrowHint = `find_usages("${args.symbol}", scope="specific_dir/")`;

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
    listLines.push(...notes);
    listLines.push(`HINT: Use ${narrowHint} to narrow, or read_symbol() on specific matches.`);

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
    // Shared file cache across sections — sequential to avoid concurrent Map writes
    const defSection = await renderSectionWithContext('DEFINITIONS', definitions, args.context_lines, projectRoot, fileCache);
    const impSection = await renderSectionWithContext('IMPORTS', allImports, args.context_lines, projectRoot, fileCache);
    const useSection = await renderSectionWithContext('USAGES', allUsages, args.context_lines, projectRoot, fileCache);
    lines.push(...defSection);
    lines.push(...impSection);
    lines.push(...useSection);
  } else {
    lines.push(...renderSection('DEFINITIONS', definitions));
    lines.push(...renderSection('IMPORTS', allImports));
    lines.push(...renderSection('USAGES', allUsages));
  }

  lines.push(...notes);
  lines.push('HINT: Use read_symbol() or read_range() to load specific results.');

  if (totalCount > 20) {
    lines.push('');
    lines.push(`NARROW: ${totalCount} matches found. Use ${narrowHint} to filter by location.`);
  }

  // Confidence metadata — resolution is judged before the kind filter.
  const truncated = cut.length > 0 || binaryCapped;
  const confidenceMeta = assessConfidence({
    refsFound: totalCount > 0,
    astAvailable: astIndex.isAvailable(),
    symbolResolved,
    truncated,
  });
  if (truncated) {
    confidenceMeta.suggestedNextStep = 'narrow with scope= or raise limit (max 500)';
  }
  if (stale) {
    confidenceMeta.knownUnknowns.push('index may be stale');
    confidenceMeta.confidence = confidenceMeta.confidence === 'high' ? 'medium' : 'low';
  }
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
