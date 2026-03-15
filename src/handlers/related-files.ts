import { existsSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import { resolveSafePath } from '../core/validation.js';

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
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [{
        type: 'text',
        text: 'related_files is disabled: ' + (astIndex.isDisabled()
          ? 'project root not detected. Call smart_read() on any project file first — this auto-detects the project root and enables ast-index tools.'
          : 'ast-index built >50k files (likely includes node_modules). Ensure node_modules is in .gitignore.')
          + '\nAlternative: use smart_read() to see file imports in the outline.',
      }],
      meta: { imports: [], importedBy: [], tests: [] },
    };
  }

  const absPath = resolveSafePath(projectRoot, args.path);
  const fileName = basename(absPath);
  const fileBase = fileName.replace(/\.\w+$/, '');
  const relatedImports = new Set<string>();

  const sections: string[] = [`RELATED FILES: ${args.path}`, ''];

  // 1. Forward imports (what this file imports)
  try {
    const imports = await astIndex.fileImports(absPath);
    if (imports && imports.length > 0) {
      sections.push('IMPORTS (this file uses):');
      for (const imp of imports) {
        const specStr = imp.specifiers?.length ? imp.specifiers.join(', ') : '*';
        sections.push(`  → ${imp.source}  (${specStr})`);
        const resolvedImport = resolveImportPath(absPath, imp.source, projectRoot);
        if (resolvedImport) {
          relatedImports.add(relative(projectRoot, resolvedImport));
        }
      }
      sections.push('');
    }
  } catch {
    // fileImports not available — skip silently
  }

  // 2. Reverse imports (what imports this file)
  const importedBy: string[] = [];
  const testFiles: string[] = [];
  const sourceLang = getLangFamily(absPath);
  try {
    // Get structure to find exported symbol names
    const structure = await astIndex.outline(absPath);
    const exportNames: string[] = [];

    if (structure) {
      for (const sym of structure.symbols) {
        exportNames.push(sym.name);
        if (exportNames.length >= 10) break;
      }
    }

    // Also try the file base name as a symbol
    if (!exportNames.includes(fileBase)) {
      exportNames.push(fileBase);
    }

    // Search refs for each exported symbol (check imports + usages)
    const seenFiles = new Set<string>();
    seenFiles.add(absPath);

    for (const name of exportNames) {
      try {
        const refs = await astIndex.refs(name, 30);

        // Check both imports and usages — imports catch direct `import X from`,
        // usages catch re-exports, function calls, type references from other files
        const refEntries = [
          ...(refs?.imports ?? []),
          ...(refs?.usages ?? []),
        ];

        for (const ref of refEntries) {
          const refPath = ref.path;
          if (!refPath || seenFiles.has(refPath)) continue;

          // Filter cross-language false positives:
          // only include files from the same language family
          if (sourceLang) {
            const refLang = getLangFamily(refPath);
            if (refLang && refLang !== sourceLang) continue;
          }

          seenFiles.add(refPath);
          importedBy.push(relative(projectRoot, refPath));
        }
      } catch {
        // skip symbol
      }
    }

    if (importedBy.length > 0) {
      sections.push('IMPORTED BY (uses this file):');
      for (const p of importedBy) {
        sections.push(`  → ${p}`);
      }
      sections.push('');
    }
  } catch {
    // refs not available — skip silently
  }

  // 3. Test files
  try {
    const allFiles = await astIndex.listFiles();

    if (allFiles && allFiles.length > 0) {
      for (const f of allFiles) {
        // Match test files for this module
        const fBase = basename(f);
        if (fBase.includes(fileBase) && TEST_PATTERNS.some(p => p.test(f))) {
          testFiles.push(relative(projectRoot, f));
        }
      }
    }

    if (testFiles.length > 0) {
      sections.push('TESTS:');
      for (const t of testFiles) {
        sections.push(`  → ${t}`);
      }
      sections.push('');
    }
  } catch {
    // listFiles not available — skip silently
  }

  // 4. Check if we found anything useful
  if (sections.length <= 2) {
    sections.push('No related files found. AST index may not cover this file.');
    sections.push('HINT: Use smart_read() to explore the file structure.');
  } else {
    // Suggested reading order
    sections.push('HINT: Use smart_read_many(paths=[...]) to read related files at once.');
  }

  return {
    content: [{ type: 'text', text: sections.join('\n') }],
    meta: {
      imports: Array.from(relatedImports).sort(),
      importedBy: Array.from(new Set(importedBy)).sort(),
      tests: Array.from(new Set(testFiles)).sort(),
    },
  };
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
