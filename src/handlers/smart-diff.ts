import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { SmartDiffArgs } from '../core/validation.js';
import type { FileStructure, SymbolInfo } from '../types.js';
import { estimateTokens } from '../core/token-estimator.js';

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface FileDiff {
  path: string;
  oldPath?: string;
  addedLines: number;
  removedLines: number;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

interface DiffHunk {
  newStart: number;
  newCount: number;
  lines: string[];
}

interface SymbolChange {
  name: string;
  kind: string;
  changeType: 'MODIFIED' | 'ADDED' | 'REMOVED';
  lineRange: string;
}

// ──────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────

const SMALL_DIFF_THRESHOLD = 30;
const MAX_FILES = 50;
const MAX_OUTPUT_LINES = 500;

export async function handleSmartDiff(
  args: SmartDiffArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }>; rawTokens: number }> {
  // 1. Build git command
  const gitArgs = buildGitArgs(args);

  // 2. Execute git diff
  let rawDiff: string;
  try {
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd: projectRoot,
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });
    rawDiff = stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not a git repository') || msg.includes('fatal:')) {
      return { content: [{ type: 'text', text: 'Not a git repository. smart_diff requires git.' }], rawTokens: 0 };
    }
    return { content: [{ type: 'text', text: `git diff failed: ${msg}` }], rawTokens: 0 };
  }

  const rawTokens = estimateTokens(rawDiff);

  if (!rawDiff.trim()) {
    const scopeLabel = args.scope ?? 'unstaged';
    return {
      content: [{ type: 'text', text: `NO CHANGES (${scopeLabel}): working tree is clean.` }],
      rawTokens: 0,
    };
  }

  // 3. Parse unified diff
  const fileDiffs = parseUnifiedDiff(rawDiff);

  if (fileDiffs.length === 0) {
    return {
      content: [{ type: 'text', text: 'NO CHANGES: diff parsed but no file changes found.' }],
      rawTokens,
    };
  }

  // 4. Map hunks to symbols (parallel, capped)
  const filesToProcess = fileDiffs.slice(0, MAX_FILES);
  const symbolChanges = new Map<string, SymbolChange[]>();

  const outlineResults = await Promise.allSettled(
    filesToProcess
      .filter(f => !f.isBinary && !f.isDeleted)
      .map(async (f) => {
        const absPath = resolve(projectRoot, f.path);
        const structure = await astIndex.outline(absPath);
        return { path: f.path, structure };
      }),
  );

  for (const result of outlineResults) {
    if (result.status === 'fulfilled' && result.value.structure) {
      const { path, structure } = result.value;
      const fd = filesToProcess.find(f => f.path === path);
      if (fd) {
        symbolChanges.set(path, mapHunksToSymbols(fd.hunks, structure));
      }
    }
  }

  // 5. Format output
  const output = formatSmartDiff(fileDiffs, filesToProcess, symbolChanges, args, rawTokens);

  return { content: [{ type: 'text', text: output }], rawTokens };
}

// ──────────────────────────────────────────────
// Git command builder
// ──────────────────────────────────────────────

function buildGitArgs(args: SmartDiffArgs): string[] {
  const base: string[] = [];

  switch (args.scope) {
    case 'staged':
      base.push('diff', '--cached', '--no-color');
      break;
    case 'commit':
      base.push('show', '--format=', '--no-color', args.ref!);
      break;
    case 'branch':
      base.push('diff', '--no-color', `${args.ref!}...HEAD`);
      break;
    case 'unstaged':
    default:
      base.push('diff', '--no-color');
      break;
  }

  if (args.path) {
    base.push('--', args.path);
  }

  return base;
}

// ──────────────────────────────────────────────
// Unified diff parser
// ──────────────────────────────────────────────

export function parseUnifiedDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of raw.split('\n')) {
    // New file
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      current = {
        path: match?.[2] ?? '',
        oldPath: match?.[1] !== match?.[2] ? match?.[1] : undefined,
        addedLines: 0,
        removedLines: 0,
        hunks: [],
        isBinary: false,
        isNew: false,
        isDeleted: false,
      };
      currentHunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
    } else if (line.startsWith('Binary files')) {
      current.isBinary = true;
    } else if (line.startsWith('rename from ')) {
      current.oldPath = line.slice(12);
    } else if (line.startsWith('@@ ')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      currentHunk = {
        newStart: match ? parseInt(match[1], 10) : 0,
        newCount: match?.[2] ? parseInt(match[2], 10) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
    } else if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.addedLines++;
        currentHunk.lines.push(line);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.removedLines++;
        currentHunk.lines.push(line);
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push(line);
      }
    }
  }

  if (current) files.push(current);
  return files;
}

// ──────────────────────────────────────────────
// Symbol mapping
// ──────────────────────────────────────────────

function flattenSymbols(symbols: SymbolInfo[], prefix = ''): Array<{ name: string; kind: string; start: number; end: number }> {
  const result: Array<{ name: string; kind: string; start: number; end: number }> = [];
  for (const sym of symbols) {
    const name = prefix ? `${prefix}.${sym.name}` : sym.name;
    result.push({
      name,
      kind: sym.kind,
      start: sym.location.startLine,
      end: sym.location.endLine,
    });
    if (sym.children.length > 0) {
      result.push(...flattenSymbols(sym.children, sym.kind === 'class' || sym.kind === 'interface' ? sym.name : ''));
    }
  }
  return result;
}

export function mapHunksToSymbols(hunks: DiffHunk[], structure: FileStructure): SymbolChange[] {
  const allSymbols = flattenSymbols(structure.symbols);
  const changedSymbols = new Map<string, SymbolChange>();

  // Classify hunks: all-added, all-removed, or mixed
  const hasAdded = hunks.some(h => h.lines.some(l => l.startsWith('+')));
  const hasRemoved = hunks.some(h => h.lines.some(l => l.startsWith('-')));

  for (const hunk of hunks) {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newCount > 0
      ? hunk.newStart + hunk.newCount - 1
      : hunk.newStart; // pure deletion: use newStart as point

    for (const sym of allSymbols) {
      if (hunkStart <= sym.end && hunkEnd >= sym.start) {
        if (!changedSymbols.has(sym.name)) {
          // Determine changeType from hunk content
          let changeType: SymbolChange['changeType'] = 'MODIFIED';
          if (hasAdded && !hasRemoved) changeType = 'ADDED';
          else if (hasRemoved && !hasAdded) changeType = 'REMOVED';

          changedSymbols.set(sym.name, {
            name: sym.name,
            kind: sym.kind,
            changeType,
            lineRange: `[L${sym.start}-${sym.end}]`,
          });
        }
      }
    }
  }

  return Array.from(changedSymbols.values());
}

// ──────────────────────────────────────────────
// Output formatter
// ──────────────────────────────────────────────

function formatSmartDiff(
  allFiles: FileDiff[],
  processedFiles: FileDiff[],
  symbolChanges: Map<string, SymbolChange[]>,
  args: SmartDiffArgs,
  rawTokens: number,
): string {
  const totalAdded = allFiles.reduce((s, f) => s + f.addedLines, 0);
  const totalRemoved = allFiles.reduce((s, f) => s + f.removedLines, 0);
  const scopeLabel = args.scope ?? 'unstaged';

  const lines: string[] = [];
  lines.push(`CHANGES: ${allFiles.length} file${allFiles.length !== 1 ? 's' : ''}, +${totalAdded} -${totalRemoved} (${scopeLabel})`);
  lines.push('');

  for (const fd of processedFiles) {
    if (lines.length >= MAX_OUTPUT_LINES) {
      lines.push(`... truncated (${allFiles.length - processedFiles.indexOf(fd)} more files)`);
      break;
    }

    // File header
    const changeLabel = fd.isNew ? ' [NEW]' : fd.isDeleted ? ' [DELETED]' : '';
    const renameLabel = fd.oldPath ? ` (renamed from ${fd.oldPath})` : '';
    const binaryLabel = fd.isBinary ? ' [BINARY]' : '';
    lines.push(`${fd.path} (+${fd.addedLines} -${fd.removedLines})${changeLabel}${renameLabel}${binaryLabel}`);

    if (fd.isBinary) {
      lines.push('');
      continue;
    }

    // Symbol changes
    const symbols = symbolChanges.get(fd.path);
    if (symbols && symbols.length > 0) {
      for (const sc of symbols) {
        const parens = ['function', 'method'].includes(sc.kind) ? '()' : '';
        lines.push(`  ${sc.changeType}: ${sc.name}${parens} ${sc.lineRange}`);
      }
    }

    // Small diff: include actual hunks
    const totalHunkLines = fd.hunks.reduce((s, h) => s + h.lines.length, 0);
    if (totalHunkLines <= SMALL_DIFF_THRESHOLD && totalHunkLines > 0) {
      for (const hunk of fd.hunks) {
        lines.push(`    @@ L${hunk.newStart}`);
        for (const hl of hunk.lines) {
          lines.push(`    ${hl}`);
        }
      }
    } else if (totalHunkLines > SMALL_DIFF_THRESHOLD) {
      lines.push(`  (${totalHunkLines} lines changed — use read_symbol for details)`);
    }

    lines.push('');
  }

  if (allFiles.length > MAX_FILES) {
    lines.push(`Showing ${MAX_FILES} of ${allFiles.length} changed files. Use path filter to narrow.`);
    lines.push('');
  }

  lines.push(`HINT: Use read_symbol(path, symbol) to see full changed code, read_diff(path) for line-level diff.`);
  lines.push(`RAW DIFF: ~${rawTokens} tokens → smart_diff: ~${estimateTokens(lines.join('\n'))} tokens`);

  return lines.join('\n');
}
