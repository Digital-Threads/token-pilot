import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { isExcludedPath, type AstIndexClient } from '../ast-index/client.js';
import type { AstIndexUnusedSymbol } from '../ast-index/types.js';
import type { SymbolInfo } from '../types.js';

const execFileAsync = promisify(execFile);

export interface FindUnusedArgs {
  module?: string;
  export_only?: boolean;
  limit?: number;
}

/**
 * Candidates asked from ast-index. node_modules declarations come first in
 * its list and crowd out project symbols, so the pool is large (≈220 bytes
 * of JSON each); most are then dropped by the cross-check.
 */
const CANDIDATE_POOL = 20_000;

/** Files larger than this are skipped by the non-git word scan. */
const MAX_SCAN_FILE_SIZE = 1_000_000;

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

/**
 * Exported by its language's rule. ast-index's `--export-only` means
 * "capitalised", which in TS/JS keeps non-exported interfaces and drops
 * exported lowercase functions.
 */
function isExported(sym: AstIndexUnusedSymbol): boolean {
  const ext = sym.path.split('.').pop()?.toLowerCase() ?? '';
  const sig = sym.signature ?? '';

  if (/^(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ext)) return /^\s*export\b/.test(sig);
  if (ext === 'py' || ext === 'pyw') return !sym.name.startsWith('_');
  if (ext === 'go') return /^[A-Z]/.test(sym.name);
  if (ext === 'rs') return /\bpub\b/.test(sig);

  return /\b(public|pub|export)\b/.test(sig) || /^[A-Z]/.test(sym.name);
}

/**
 * `file:line:name` of every word occurrence of `names` in project files, or
 * null when no search could run. Git repos use `git grep` over tracked and
 * untracked (not ignored) files; otherwise the indexed file list is scanned.
 */
async function wordOccurrences(
  names: string[],
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<Array<{ file: string; line: number; name: string }> | null> {
  if (names.length === 0) return [];

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['grep', '--untracked', '-I', '-n', '-o', '-w', '-F', ...names.flatMap((n) => ['-e', n])],
      { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
    );
    return parseGrep(stdout);
  } catch (err) {
    // exit 1 = no match anywhere
    if ((err as { code?: number }).code === 1) return [];
  }

  const files = await astIndex.listFiles();
  if (files.length === 0) return null;

  const wanted = new Set(names);
  const out: Array<{ file: string; line: number; name: string }> = [];
  for (const file of files) {
    try {
      const abs = resolve(projectRoot, file);
      if ((await stat(abs)).size > MAX_SCAN_FILE_SIZE) continue;
      const lines = (await readFile(abs, 'utf-8')).split('\n');
      lines.forEach((text, i) => {
        for (const m of text.matchAll(/[A-Za-z0-9_$]+/g)) {
          if (wanted.has(m[0])) out.push({ file, line: i + 1, name: m[0] });
        }
      });
    } catch {
      // unreadable file — skip
    }
  }

  return out;
}

/** `git grep -n -o` lines: `path:line:match`. */
function parseGrep(stdout: string): Array<{ file: string; line: number; name: string }> {
  const out: Array<{ file: string; line: number; name: string }> = [];
  for (const row of stdout.split('\n')) {
    const m = row.match(/^(.+?):(\d+):(.+)$/);
    if (m) out.push({ file: m[1], line: parseInt(m[2], 10), name: m[3] });
  }
  return out;
}

export async function handleFindUnused(
  args: FindUnusedArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }>; meta: { files: string[] } }> {
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return { content: [{ type: 'text', text:
      'find_unused is disabled: ' + (astIndex.isDisabled()
        ? 'project root not detected. Call smart_read() on any project file first — this auto-detects the project root and enables ast-index tools.'
        : 'ast-index built >50k files (likely includes node_modules). Ensure node_modules is in .gitignore.') +
      '\nAlternative: use Grep to find unused exports manually.' }], meta: { files: [] } };
  }

  const projectRoot = astIndex.getProjectRoot();
  const unused = await astIndex.unusedSymbols({
    module: args.module,
    limit: CANDIDATE_POOL,
  });
  const poolCapped = !!unused.truncated;

  // Step 1: language-level exclusions and export_only (by language rule)
  const candidates = unused.filter(sym =>
    !isConstructor(sym.name) &&
    !isDunderMethod(sym.name) &&
    !isExcludedPath(sym.path) &&
    (!args.export_only || isExported(sym)),
  );
  const langExcluded = unused.filter(s => isConstructor(s.name) || isDunderMethod(s.name)).length;

  // Step 2: cross-check — any word occurrence other than the definition
  // line (same file, tests, member calls, callbacks, comments) drops it.
  const occurrences = await wordOccurrences(
    [...new Set(candidates.map(s => s.name))],
    projectRoot,
    astIndex,
  );
  if (occurrences === null) {
    return {
      content: [{
        type: 'text',
        text: `find_unused could not verify ${candidates.length} candidates from ast-index (no git repository and no indexed file list), so none are reported — ast-index's list alone is mostly false positives.\nAlternative: Grep each name you suspect.`,
      }],
      meta: { files: [] },
    };
  }
  const referenced = new Set<string>();
  const defLines = new Set(candidates.map(s => `${s.path}:${s.line}:${s.name}`));
  for (const o of occurrences) {
    if (isExcludedPath(o.file)) continue;
    if (!defLines.has(`${o.file}:${o.line}:${o.name}`)) referenced.add(o.name);
  }
  const verified = candidates.filter(s => !referenced.has(s.name));
  const droppedReferenced = candidates.length - verified.length;

  // Step 3: decorators from outlines — framework-invoked symbols listed apart
  const uniqueFiles = [...new Set(verified.map(s => s.path))];
  const outlineCache = new Map<string, SymbolInfo[]>();
  const batchSize = 10;
  for (let i = 0; i < uniqueFiles.length; i += batchSize) {
    const batch = uniqueFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const outline = await astIndex.outline(resolve(projectRoot, file));
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

  const enriched = verified.map(sym => ({
    ...sym,
    decorators: findSymbolDecorators(sym.name, sym.line, outlineCache.get(sym.path) ?? []),
  }));
  const decorated = enriched.filter(s => s.decorators.length > 0);
  const trulyUnused = enriched.filter(s => s.decorators.length === 0);

  const limit = args.limit ?? 30;
  const trimmed = trulyUnused.slice(0, limit);

  const footer: string[] = [];
  if (droppedReferenced > 0) {
    footer.push(`(${droppedReferenced} ast-index candidates dropped: referenced somewhere — same file, tests, member calls, callbacks or comments)`);
  }
  if (langExcluded > 0) {
    footer.push(`(${langExcluded} constructors/protocol methods excluded)`);
  }
  if (poolCapped) {
    footer.push(`ast-index returned its candidate cap of ${CANDIDATE_POOL} — more may exist; narrow with module=.`);
  }

  if (trimmed.length === 0 && decorated.length === 0) {
    const where = args.module ? `in module "${args.module}"` : 'in the project';
    return {
      content: [{ type: 'text', text: [`No unused symbols found ${where}.`, ...footer].join('\n') }],
      meta: { files: [] },
    };
  }

  const lines: string[] = [];

  if (trimmed.length > 0) {
    const shown = trulyUnused.length > limit ? ` (showing ${limit} of ${trulyUnused.length})` : '';
    lines.push(`UNUSED SYMBOLS: ${trimmed.length} with no reference anywhere in the project${shown}`);
    lines.push('  (word search across every project file — tests, comments and the defining file included)');
    lines.push('');

    for (const [file, symbols] of groupByFile(trimmed)) {
      lines.push(`  ${file}:`);
      for (const s of symbols) {
        lines.push(`    ${s.kind} ${s.name} (L${s.line})`);
      }
    }
    lines.push('');
  }

  if (decorated.length > 0) {
    lines.push(`DECORATED (${decorated.length} — likely framework-invoked, verify manually):`);
    for (const [file, symbols] of groupByFile(decorated)) {
      lines.push(`  ${file}:`);
      for (const s of symbols) {
        const decs = s.decorators.map(d => `@${d}`).join(' ');
        lines.push(`    ${s.kind} ${s.name} (L${s.line})  ${decs}`);
      }
    }
    lines.push('');
  }

  lines.push(...footer);
  lines.push('NOTE: Verify before removing — a symbol can still be reached dynamically (string lookup, reflection, framework conventions, a library\'s public API).');

  const files = [...new Set([...trimmed, ...decorated].map(s => s.path))];
  return { content: [{ type: 'text', text: lines.join('\n') }], meta: { files } };
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
