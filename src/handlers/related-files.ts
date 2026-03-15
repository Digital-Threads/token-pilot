import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
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

const TEST_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /_test\.\w+$/,
  /test_[^/]+\.\w+$/,
  /__tests__\//,
  /\/tests?\//,
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

  // 1. Forward imports (what this file imports) → +4 per file
  try {
    const imports = await astIndex.fileImports(absPath);
    if (imports && imports.length > 0) {
      for (const imp of imports) {
        const resolvedImport = resolveImportPath(absPath, imp.source, projectRoot);
        if (resolvedImport) {
          const relPath = relative(projectRoot, resolvedImport);
          importPaths.add(relPath);
          addScore(relPath, 4, 'import');
          // Same directory bonus
          if (dirname(resolvedImport) === fileDir) {
            addScore(relPath, 2, 'same-dir');
          }
        }
      }
    }
  } catch {
    // fileImports not available — skip silently
  }

  // 2. Reverse imports (what imports this file) → +3 per file, +1 per extra ref
  const sourceLang = getLangFamily(absPath);
  try {
    const structure = await astIndex.outline(absPath);
    const exportNames: string[] = [];

    if (structure) {
      for (const sym of structure.symbols) {
        exportNames.push(sym.name);
        if (exportNames.length >= 10) break;
      }
    }

    if (!exportNames.includes(fileBase)) {
      exportNames.push(fileBase);
    }

    const seenFiles = new Set<string>();
    seenFiles.add(absPath);
    // Track ref count per file for multi-ref bonus
    const refCounts = new Map<string, number>();

    for (const name of exportNames) {
      try {
        const refs = await astIndex.refs(name, 30);
        const refEntries = [
          ...(refs?.imports ?? []),
          ...(refs?.usages ?? []),
        ];

        for (const ref of refEntries) {
          const refPath = ref.path;
          if (!refPath || seenFiles.has(refPath)) {
            // Still count extra refs for already-seen files
            if (refPath && refPath !== absPath) {
              const rp = relative(projectRoot, refPath);
              refCounts.set(rp, (refCounts.get(rp) ?? 0) + 1);
            }
            continue;
          }

          if (sourceLang) {
            const refLang = getLangFamily(refPath);
            if (refLang && refLang !== sourceLang) continue;
          }

          seenFiles.add(refPath);
          const relPath = relative(projectRoot, refPath);
          importedByPaths.push(relPath);
          refCounts.set(relPath, (refCounts.get(relPath) ?? 0) + 1);
          addScore(relPath, 3, 'importer');
          // Same directory bonus
          if (dirname(refPath) === fileDir) {
            addScore(relPath, 2, 'same-dir');
          }
        }
      } catch {
        // skip symbol
      }
    }

    // Apply multi-ref bonus: +1 per extra ref beyond the first
    for (const [relPath, count] of refCounts) {
      if (count > 1) {
        addScore(relPath, count - 1, 'multi-ref');
      }
    }
  } catch {
    // refs not available — skip silently
  }

  // 3. Test files → +5 per file
  try {
    const allFiles = await astIndex.listFiles();

    if (allFiles && allFiles.length > 0) {
      for (const f of allFiles) {
        const fBase = basename(f);
        if (fBase.includes(fileBase) && TEST_PATTERNS.some(p => p.test(f))) {
          const relPath = relative(projectRoot, f);
          testPaths.push(relPath);
          addScore(relPath, 5, 'test');
        }
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

function resolveImportPath(
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

  const candidates = [
    basePath,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.go', '.rs', '.java', '.kt', '.swift']
      .flatMap((ext) => [`${basePath}${ext}`, resolve(basePath, `index${ext}`)]),
  ];

  for (const candidate of candidates) {
    if (candidate.startsWith(projectRoot) && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
