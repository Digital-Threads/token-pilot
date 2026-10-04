import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { AstIndexImportEntry } from '../ast-index/types.js';
import { resolveSafePath } from '../core/validation.js';

const execFileAsync = promisify(execFile);

/**
 * Language families — files with extensions in the same family are considered related.
 * This prevents cross-language false positives (e.g. Python files showing as importers of TS).
 */
const LANG_FAMILIES: Record<string, string> = {
  '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm', '.scala': 'jvm', '.groovy': 'jvm',
  '.cs': 'dotnet',
  '.rb': 'rb',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'c', '.cc': 'c', '.cxx': 'c', '.hpp': 'c',
  '.dart': 'dart',
  '.ex': 'elixir', '.exs': 'elixir',
  '.vue': 'js', '.svelte': 'js',
};

function getLangFamily(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  return LANG_FAMILIES[ext];
}

export interface RelatedFilesArgs {
  path: string;
}

export interface RelatedFilesMeta {
  imports: string[];
  importedBy: string[];
  tests: string[];
  ranked: {
    high: string[];
    medium: string[];
    low: string[];
  };
}

interface RankedFile {
  relPath: string;
  score: number;
  tags: string[];
}

/** Possible importers checked by reading their imports. */
const MAX_IMPORTER_CHECKS = 100;

/** Test file by its name (`x.test.ts`, `x_test.go`, `test_x.py`) or a __tests__ dir. */
export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.\w+$|_(test|spec)\.\w+$|(^|\/)test_[^/]+$|(^|\/)__tests__\//.test(rel);
}

/** Anything under a test location, helpers and fixtures included. */
export function isTestPath(rel: string): boolean {
  return TEST_PATTERNS.some(p => p.test(rel));
}

const TEST_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /_test\.\w+$/,
  /test_[^/]+\.\w+$/,
  /__tests__\//,
  /(^|\/)tests?\//,
];

export async function handleRelatedFiles(
  args: RelatedFilesArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }>; meta: RelatedFilesMeta }> {
  const emptyMeta: RelatedFilesMeta = { imports: [], importedBy: [], tests: [], ranked: { high: [], medium: [], low: [] } };

  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [{
        type: 'text',
        text: 'related_files is disabled: ' + (astIndex.isDisabled()
          ? 'project root not detected. Call smart_read() on any project file first — this auto-detects the project root and enables ast-index tools.'
          : 'ast-index built >50k files (likely includes node_modules). Ensure node_modules is in .gitignore.')
          + '\nAlternative: use smart_read() to see file imports in the outline.',
      }],
      meta: emptyMeta,
    };
  }

  const absPath = resolveSafePath(projectRoot, args.path);
  const fileName = basename(absPath);
  const fileBase = fileName.replace(/\.\w+$/, '');
  const fileDir = dirname(absPath);
  // ast-index answers with project-relative paths; never resolve them
  // against the server's cwd.
  const relOf = (p: string) =>
    (isAbsolute(p) ? relative(projectRoot, p) : p).split(sep).join('/');
  const targetRel = relOf(absPath);

  // Scoring map: relPath → RankedFile
  const fileScores = new Map<string, RankedFile>();

  function addScore(relPath: string, points: number, tag: string): void {
    const existing = fileScores.get(relPath);
    if (existing) {
      existing.score += points;
      if (!existing.tags.includes(tag)) existing.tags.push(tag);
    } else {
      fileScores.set(relPath, { relPath, score: points, tags: [tag] });
    }
  }

  // Track original categories for backwards-compatible meta
  const importPaths = new Set<string>();
  const importedByPaths: string[] = [];
  const testPaths: string[] = [];
  const notes: string[] = [];

  // 1. Forward imports (what this file imports) → +4 per file
  try {
    const imports = await astIndex.fileImports(absPath);
    for (const imp of imports ?? []) {
      const resolvedImport = resolveImportPath(absPath, imp.source, projectRoot);
      if (resolvedImport) {
        const relPath = relOf(resolvedImport);
        importPaths.add(relPath);
        addScore(relPath, 4, 'import');
        // Same directory bonus
        if (dirname(resolvedImport) === fileDir) {
          addScore(relPath, 2, 'same-dir');
        }
      }
    }
  } catch {
    // fileImports not available — skip silently
  }

  // 2. Reverse imports. Candidates: files whose import lines mention the
  // module name, and files referencing its top symbols. A candidate counts
  // only when one of its imports resolves to this file → +3, +1 per extra ref.
  const sourceLang = getLangFamily(absPath);
  const candidates = new Map<string, number>(); // relPath → refs seen
  const see = (p: string | undefined) => {
    if (!p) return;
    const rel = relOf(p);
    if (rel === targetRel) return;
    if (sourceLang) {
      const lang = getLangFamily(rel);
      if (lang && lang !== sourceLang) return;
    }
    candidates.set(rel, (candidates.get(rel) ?? 0) + 1);
  };

  try {
    const hits = await astIndex.search(fileBase, { maxResults: 500 });
    for (const h of hits) {
      if (/\b(import|from|require|use|include)\b/.test(h.text)) see(h.file);
    }
    if (hits.truncated) notes.push(`search for "${fileBase}" hit its cap — some importers may be missing`);
  } catch {
    // search not available — refs below still run
  }

  try {
    const structure = await astIndex.outline(absPath);
    const names = (structure?.symbols ?? []).slice(0, 10).map(s => s.name);
    for (const name of names) {
      try {
        const refs = await astIndex.refs(name, 50);
        for (const ref of [...(refs?.imports ?? []), ...(refs?.usages ?? [])]) see(ref.path);
      } catch {
        // skip symbol
      }
    }
  } catch {
    // refs not available — skip silently
  }

  const toVerify = [...candidates.keys()].slice(0, MAX_IMPORTER_CHECKS);
  if (candidates.size > MAX_IMPORTER_CHECKS) {
    notes.push(`${candidates.size - MAX_IMPORTER_CHECKS} possible importers not checked (cap ${MAX_IMPORTER_CHECKS})`);
  }
  const verified = await Promise.all(
    toVerify.map(async (rel) => {
      try {
        const importerAbs = resolve(projectRoot, rel);
        const imps = await astIndex.fileImports(importerAbs);
        return (imps ?? []).some(i => importsTarget(importerAbs, i, absPath, projectRoot));
      } catch {
        return false;
      }
    }),
  );
  toVerify.forEach((rel, i) => {
    if (!verified[i]) return;
    importedByPaths.push(rel);
    addScore(rel, 3, 'importer');
    const count = candidates.get(rel) ?? 1;
    if (count > 1) addScore(rel, count - 1, 'multi-ref');
    if (dirname(resolve(projectRoot, rel)) === fileDir) addScore(rel, 2, 'same-dir');
    if (TEST_PATTERNS.some(p => p.test(rel))) {
      testPaths.push(rel);
      addScore(rel, 5, 'test');
    }
  });

  // 3. Test files named after this file (`x.test.ts`, `test_x.py`, `x_test.go`) → +5
  try {
    for (const f of await astIndex.listFiles()) {
      const rel = relOf(f);
      if (testPaths.includes(rel) || !isTestFile(rel)) continue;
      if (testSubject(basename(rel)) === fileBase) {
        testPaths.push(rel);
        addScore(rel, 5, 'test');
      }
    }
  } catch {
    // listFiles not available — skip silently
  }

  // 4. Recently changed files → +2 boost
  const changedFiles = await getRecentlyChangedFiles(projectRoot);
  for (const [, ranked] of fileScores) {
    if (changedFiles.has(ranked.relPath)) {
      addScore(ranked.relPath, 2, 'changed');
    }
  }

  // 5. Sort by score and bucket into high/medium/low
  const allRanked = Array.from(fileScores.values()).sort((a, b) => b.score - a.score);

  const high: RankedFile[] = [];
  const medium: RankedFile[] = [];
  const low: RankedFile[] = [];

  for (const r of allRanked) {
    if (r.score >= 5) high.push(r);
    else if (r.score >= 3) medium.push(r);
    else low.push(r);
  }

  // 6. Build output
  const sections: string[] = [`RELATED FILES: ${args.path}`, ''];

  if (high.length > 0) {
    sections.push(`HIGH VALUE (${high.length} file${high.length > 1 ? 's' : ''} — read these first):`);
    for (const r of high) {
      sections.push(`  ★ ${r.relPath}  [${r.tags.join(', ')}]`);
    }
    sections.push('');
  }

  if (medium.length > 0) {
    sections.push(`MEDIUM (${medium.length} file${medium.length > 1 ? 's' : ''}):`);
    for (const r of medium) {
      sections.push(`  · ${r.relPath}  [${r.tags.join(', ')}]`);
    }
    sections.push('');
  }

  if (low.length > 0) {
    sections.push(`LOW (${low.length} file${low.length > 1 ? 's' : ''} — read only if needed):`);
    for (const r of low) {
      sections.push(`  · ${r.relPath}  [${r.tags.join(', ')}]`);
    }
    sections.push('');
  }

  for (const note of notes) sections.push(`NOTE: ${note}`);

  if (allRanked.length === 0) {
    sections.push('No related files found. AST index may not cover this file.');
    sections.push('HINT: Use smart_read() to explore the file structure.');
  } else {
    const highPaths = high.map(r => `"${r.relPath}"`).join(', ');
    if (high.length > 0) {
      sections.push(`HINT: Use smart_read_many(paths=[${highPaths}]) to read the most relevant files.`);
    } else {
      sections.push('HINT: Use smart_read_many(paths=[...]) to read related files at once.');
    }
  }

  return {
    content: [{ type: 'text', text: sections.join('\n') }],
    meta: {
      imports: Array.from(importPaths).sort(),
      importedBy: Array.from(new Set(importedByPaths)).sort(),
      tests: Array.from(new Set(testPaths)).sort(),
      ranked: {
        high: high.map(r => r.relPath),
        medium: medium.map(r => r.relPath),
        low: low.map(r => r.relPath),
      },
    },
  };
}

/** Get files changed in the last 5 commits (single git call). */
async function getRecentlyChangedFiles(projectRoot: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~5'], {
      cwd: projectRoot,
      timeout: 5000,
    });
    const files = stdout.trim().split('\n').filter(Boolean);
    return new Set(files);
  } catch {
    // git not available, not a repo, or <5 commits — try smaller range
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1'], {
        cwd: projectRoot,
        timeout: 5000,
      });
      const files = stdout.trim().split('\n').filter(Boolean);
      return new Set(files);
    } catch {
      return new Set();
    }
  }
}

export function resolveImportPath(
  sourceFile: string,
  importSource: string,
  projectRoot: string,
): string | null {
  if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
    return null;
  }

  const basePath = importSource.startsWith('/')
    ? resolve(projectRoot, '.' + importSource)
    : resolve(dirname(sourceFile), importSource);

  // TS sources import their compiled name: './x.js' → x.ts / x.tsx.
  const twin = basePath.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
  const twins = twin
    ? ({ js: ['.ts', '.tsx'], jsx: ['.tsx'], mjs: ['.mts'], cjs: ['.cts'] } as Record<string, string[]>)[twin[2]]
        .map((ext) => twin[1] + ext)
    : [];

  const candidates = [
    basePath,
    ...twins,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.go', '.rs', '.java', '.kt', '.swift']
      .flatMap((ext) => [`${basePath}${ext}`, resolve(basePath, `index${ext}`)]),
  ];

  for (const candidate of candidates) {
    if (candidate.startsWith(projectRoot) && isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `cache.test.ts` / `cache.spec.js` / `test_cache.py` / `cache_test.go` → `cache`. */
export function testSubject(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](test|spec)$/i, '')
    .replace(/^test_/i, '');
}

/**
 * True when `imp` (an import of `importerAbs`) points at `targetAbs`.
 * Relative specifiers are resolved; module paths of other languages
 * (`pkg.models`, `com.x.Svc`, `crate::a::b`, Go package dirs) are matched
 * as path suffixes. JS bare specifiers (`react`, `node:fs`) never match.
 */
function importsTarget(
  importerAbs: string,
  imp: AstIndexImportEntry,
  targetAbs: string,
  projectRoot: string,
): boolean {
  const resolved = resolveImportPath(importerAbs, imp.source, projectRoot);
  if (resolved) return resolved === targetAbs;
  if (getLangFamily(importerAbs) === 'js') return false;

  const targetRel = relative(projectRoot, targetAbs).split(sep).join('/');
  const noExt = targetRel.replace(/\.[^./]+$/, '');
  const dir = dirname(targetRel);
  const isGo = extname(importerAbs) === '.go';
  const spec = imp.source
    .replace(/['";]/g, '')
    .replace(/::|\./g, '/')
    .replace(/^(crate|self|super)\//, '');
  const parts = spec.split('/').filter(Boolean);
  const tries = [
    parts.join('/'),
    parts.slice(0, -1).join('/'),
    ...imp.specifiers.map((name) => `${parts.join('/')}/${name}`),
  ].filter(Boolean);
  const endsWith = (path: string, tail: string) => path === tail || path.endsWith(`/${tail}`);

  return tries.some((t) => endsWith(noExt, t) || (isGo && endsWith(dir, t)));
}
