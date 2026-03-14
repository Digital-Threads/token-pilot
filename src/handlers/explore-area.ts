import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, basename, dirname } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { ExploreAreaArgs } from '../core/validation.js';
import { resolveSafePath } from '../core/validation.js';
import { outlineDir, CODE_EXTENSIONS } from './outline.js';

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MAX_IMPORT_FILES = 20;
const MAX_OUTPUT_LINES = 500;

// ──────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────

export async function handleExploreArea(
  args: ExploreAreaArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Resolve path — if it points to a file, use its parent directory
  let absPath = resolveSafePath(projectRoot, args.path);
  const pathStat = await stat(absPath).catch(() => null);
  if (!pathStat) {
    return {
      content: [{ type: 'text', text: `Path "${args.path}" not found.` }],
    };
  }
  if (!pathStat.isDirectory()) {
    absPath = dirname(absPath);
  }

  const relDir = relative(projectRoot, absPath) || '.';
  const include = args.include ?? ['outline', 'imports', 'tests', 'changes'];

  // Collect code files for import/test analysis
  const codeFiles = await listCodeFiles(absPath);

  // Run all sections in parallel
  const [outlineSection, importsSection, testsSection, changesSection] = await Promise.allSettled([
    include.includes('outline') ? buildOutlineSection(absPath, projectRoot, astIndex) : Promise.resolve(null),
    include.includes('imports') ? buildImportsSection(codeFiles, absPath, projectRoot, astIndex) : Promise.resolve(null),
    include.includes('tests') ? buildTestsSection(codeFiles, absPath, projectRoot) : Promise.resolve(null),
    include.includes('changes') ? buildChangesSection(relDir, projectRoot) : Promise.resolve(null),
  ]);

  // Assemble output
  const lines: string[] = [];
  const subdirCount = await countSubdirs(absPath);
  lines.push(`AREA: ${relDir}/ (${codeFiles.length} code files${subdirCount > 0 ? `, ${subdirCount} subdirs` : ''})`);
  lines.push('');

  // Outline
  const outlineLines = extractResult(outlineSection);
  if (outlineLines) {
    lines.push('STRUCTURE:');
    lines.push(...outlineLines);
    lines.push('');
  }

  // Imports
  const importLines = extractResult(importsSection);
  if (importLines) {
    lines.push(...importLines);
  }

  // Tests
  const testLines = extractResult(testsSection);
  if (testLines) {
    lines.push(...testLines);
  }

  // Changes
  const changeLines = extractResult(changesSection);
  if (changeLines) {
    lines.push(...changeLines);
  }

  // Truncate if needed
  if (lines.length > MAX_OUTPUT_LINES) {
    lines.length = MAX_OUTPUT_LINES;
    lines.push('... truncated. Use outline() on specific subdirectories for details.');
  }

  lines.push('HINT: Use smart_read(file) for details, read_symbol(path, symbol) for source code, find_usages(symbol) for references.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ──────────────────────────────────────────────
// Outline section — reuses outlineDir from outline.ts
// ──────────────────────────────────────────────

async function buildOutlineSection(
  absPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<string[]> {
  const sections: string[] = [];
  await outlineDir(absPath, sections, 0, 2, projectRoot, astIndex);
  return sections;
}

// ──────────────────────────────────────────────
// Imports section — aggregate external deps + who imports this area
// ──────────────────────────────────────────────

async function buildImportsSection(
  codeFiles: string[],
  absPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<string[]> {
  if (!astIndex.isAvailable() || astIndex.isDisabled() || astIndex.isOversized()) {
    return [];
  }

  const filesToAnalyze = codeFiles.slice(0, MAX_IMPORT_FILES);
  const externalDeps = new Set<string>();
  const internalDeps = new Set<string>();
  const relDir = relative(projectRoot, absPath) || '.';

  // Get imports for each file
  const importResults = await Promise.allSettled(
    filesToAnalyze.map(f => astIndex.fileImports(f)),
  );

  for (const result of importResults) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    for (const imp of result.value) {
      const source = imp.source;
      if (!source) continue;
      if (source.startsWith('.') || source.startsWith('/')) {
        // Internal import — track if it's outside this area
        const resolved = resolve(absPath, source);
        if (!resolved.startsWith(absPath)) {
          const relImport = relative(projectRoot, resolved).replace(/\.[^.]+$/, '');
          internalDeps.add(relImport);
        }
      } else {
        // External package
        const pkg = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
        externalDeps.add(pkg);
      }
    }
  }

  // Find who imports files from this area (reverse dependencies)
  const importedBy = new Set<string>();
  const fileBasenames = filesToAnalyze.map(f => basename(f).replace(/\.[^.]+$/, ''));

  const refResults = await Promise.allSettled(
    fileBasenames.slice(0, 10).map(name => astIndex.refs(name, 10)),
  );

  for (const result of refResults) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const refs = result.value;
    if (refs.imports) {
      for (const imp of refs.imports) {
        const impFile = imp.path;
        if (!impFile) continue;
        const relFile = relative(projectRoot, impFile);
        // Only include files outside this area
        if (!relFile.startsWith(relDir)) {
          importedBy.add(relFile.replace(/\.[^.]+$/, ''));
        }
      }
    }
  }

  const lines: string[] = [];

  if (externalDeps.size > 0) {
    const deps = Array.from(externalDeps).sort().slice(0, 20);
    lines.push(`IMPORTS: ${deps.join(', ')}${externalDeps.size > 20 ? ` ... (${externalDeps.size} total)` : ''}`);
  }

  if (internalDeps.size > 0) {
    const deps = Array.from(internalDeps).sort().slice(0, 10);
    lines.push(`INTERNAL DEPS: ${deps.join(', ')}${internalDeps.size > 10 ? ` ... (${internalDeps.size} total)` : ''}`);
  }

  if (importedBy.size > 0) {
    const importers = Array.from(importedBy).sort().slice(0, 10);
    lines.push(`IMPORTED BY: ${importers.join(', ')}${importedBy.size > 10 ? ` ... (${importedBy.size} total)` : ''}`);
  }

  if (lines.length > 0) lines.push('');
  return lines;
}

// ──────────────────────────────────────────────
// Tests section — find test/spec files matching area files
// ──────────────────────────────────────────────

async function buildTestsSection(
  codeFiles: string[],
  absPath: string,
  projectRoot: string,
): Promise<string[]> {
  const testFiles: string[] = [];
  const areaFileNames = new Set(codeFiles.map(f => basename(f).replace(/\.[^.]+$/, '')));

  // Scan for test files: check area dir + common test dirs
  const dirsToScan = [absPath];

  // Check for sibling __tests__ or tests directory
  const parent = dirname(absPath);
  const areaName = basename(absPath);
  const testDirCandidates = [
    resolve(absPath, '__tests__'),
    resolve(absPath, 'tests'),
    resolve(absPath, 'test'),
    resolve(parent, '__tests__', areaName),
    resolve(parent, 'tests', areaName),
  ];

  for (const testDir of testDirCandidates) {
    const testDirStat = await stat(testDir).catch(() => null);
    if (testDirStat?.isDirectory()) {
      dirsToScan.push(testDir);
    }
  }

  // Also check project-level test directories
  const projectTestDirs = [
    resolve(projectRoot, 'tests'),
    resolve(projectRoot, 'test'),
    resolve(projectRoot, '__tests__'),
  ];
  for (const testDir of projectTestDirs) {
    if (dirsToScan.includes(testDir)) continue;
    const testDirStat = await stat(testDir).catch(() => null);
    if (testDirStat?.isDirectory()) {
      dirsToScan.push(testDir);
    }
  }

  for (const dir of dirsToScan) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (name.includes('.test.') || name.includes('.spec.') || name.includes('_test.') || name.includes('_spec.')) {
          // Check if this test corresponds to an area file
          const testBase = name
            .replace(/\.(test|spec)\./, '.')
            .replace(/_(test|spec)\./, '.')
            .replace(/\.[^.]+$/, '');
          if (areaFileNames.has(testBase) || dir !== absPath) {
            const relPath = relative(projectRoot, resolve(dir, name));
            if (!testFiles.includes(relPath)) {
              testFiles.push(relPath);
            }
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  if (testFiles.length === 0) return [];

  const lines: string[] = [];
  lines.push(`TESTS: ${testFiles.join(', ')}`);
  lines.push('');
  return lines;
}

// ──────────────────────────────────────────────
// Changes section — recent git log for this area
// ──────────────────────────────────────────────

async function buildChangesSection(
  relDir: string,
  projectRoot: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', '-5', '--', relDir],
      { cwd: projectRoot, timeout: 5000 },
    );

    if (!stdout.trim()) return [];

    const lines: string[] = [];
    lines.push('RECENT CHANGES:');
    for (const line of stdout.trim().split('\n')) {
      lines.push(`  ${line}`);
    }
    lines.push('');
    return lines;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function extractResult(settled: PromiseSettledResult<string[] | null>): string[] | null {
  if (settled.status === 'fulfilled' && settled.value && settled.value.length > 0) {
    return settled.value;
  }
  return null;
}

async function listCodeFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(resolve(dirPath, entry.name));
        }
      }
    }
    return files.sort();
  } catch {
    return [];
  }
}

async function countSubdirs(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).length;
  } catch {
    return 0;
  }
}
