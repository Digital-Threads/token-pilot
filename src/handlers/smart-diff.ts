import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; rawTokens: number };

// ──────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────

const SMALL_DIFF_THRESHOLD = 30;
/** Files whose symbols get mapped (each costs two outlines). */
const MAX_FILES = 50;
const MAX_OUTPUT_LINES = 500;
const MAX_SYMBOLS_PER_FILE = 20;
const MAX_UNTRACKED_LISTED = 10;
/** Revision side meaning "the file on disk". */
const WORKTREE = Symbol('worktree');
type Side = string | typeof WORKTREE | null;

function reply(text: string, rawTokens = 0): ToolResult {
  return { content: [{ type: 'text', text }], rawTokens };
}

async function git(projectRoot: string, args: string[]): Promise<string> {
  // core.quotePath=false: non-ASCII paths come out as-is instead of "\303\251".
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: projectRoot,
    timeout: 10000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

function gitErrorText(err: unknown): string {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? '').trim();
  return stderr || (err instanceof Error ? err.message : String(err));
}

export async function handleSmartDiff(
  args: SmartDiffArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<ToolResult> {
  let rawDiff: string;
  try {
    const renamePaths = await renamePartners(args, projectRoot);
    rawDiff = await git(projectRoot, buildGitArgs(args, renamePaths));
  } catch (err) {
    const msg = gitErrorText(err);
    if (/not a git repository/i.test(msg)) {
      return reply('Not a git repository. smart_diff requires git.');
    }
    return reply(`git ${scopeArgs(args)[0]} failed: ${msg.split('\n')[0]}`);
  }

  const untracked = (args.scope ?? 'unstaged') === 'unstaged'
    ? await listUntracked(projectRoot, args.path)
    : [];

  if (!rawDiff.trim()) {
    return reply([emptyMessage(args), ...untrackedLines(untracked)].join('\n'));
  }

  const rawTokens = estimateTokens(rawDiff);
  const fileDiffs = parseUnifiedDiff(rawDiff);

  if (fileDiffs.length === 0) {
    return reply('NO CHANGES: diff parsed but no file changes found.', rawTokens);
  }

  // Map changed lines to symbols — new side and old side each outlined from
  // the right revision, not from whatever the working tree holds now.
  const textFiles = fileDiffs.filter(f => !f.isBinary);
  const toMap = textFiles.slice(0, MAX_FILES);
  const sides = await revisionSides(args, projectRoot);
  const symbolChanges = new Map<string, SymbolChange[]>();

  for (let i = 0; i < toMap.length; i += 10) {
    await Promise.all(toMap.slice(i, i + 10).map(async (fd) => {
      const [newStructure, oldStructure] = await Promise.all([
        fd.isDeleted ? null : outlineAt(sides.newSide, fd.path, sides.root, astIndex),
        fd.isNew ? null : outlineAt(sides.oldSide, fd.oldPath ?? fd.path, sides.root, astIndex),
      ]);

      // A file that still exists but could not be outlined: symbols unknown.
      if (!fd.isDeleted && !newStructure) return;
      if (!newStructure && !oldStructure) return;

      symbolChanges.set(fd.path, mapHunksToSymbols(fd.hunks, newStructure, oldStructure));
    }));
  }

  const output = formatSmartDiff(fileDiffs, symbolChanges, args, rawTokens, textFiles.length - toMap.length, untracked);

  // A summary that costs more than the diff itself is no summary.
  if (estimateTokens(output) >= rawTokens) {
    return reply([rawDiff.trimEnd(), ...untrackedLines(untracked)].join('\n'), rawTokens);
  }

  return reply(output, rawTokens);
}

// ──────────────────────────────────────────────
// Git commands
// ──────────────────────────────────────────────

function scopeArgs(args: SmartDiffArgs): string[] {
  // Explicit prefixes: a user's diff.noprefix / diff.mnemonicPrefix must not
  // change what the parser sees.
  const common = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

  switch (args.scope) {
    case 'staged':
      return ['diff', '--cached', ...common];
    case 'commit':
      // first-parent: a merge commit shows what it brought in, not nothing.
      return ['show', '--format=', '--diff-merges=first-parent', ...common, args.ref!];
    case 'branch':
      return ['diff', ...common, `${args.ref!}...HEAD`];
    case 'unstaged':
    default:
      return ['diff', ...common];
  }
}

function buildGitArgs(args: SmartDiffArgs, extraPaths: string[] = []): string[] {
  const base = scopeArgs(args);

  if (args.path) {
    base.push('--', args.path, ...extraPaths);
  }

  return base;
}

/**
 * A path filter on one side of a rename hides the other side, and git then
 * reports a deletion (or an addition). Find the partner so both go in.
 */
async function renamePartners(args: SmartDiffArgs, projectRoot: string): Promise<string[]> {
  if (!args.path) return [];

  const [command, ...rest] = scopeArgs(args);
  const fields = (await git(projectRoot, [command, '--name-status', '-M', '-z', ...rest])).split('\0');
  const filter = args.path.replace(/^\.\//, '').replace(/\/+$/, '');
  const inFilter = (p: string) => p === filter || p.startsWith(filter + '/');
  const partners: string[] = [];

  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    if (!status) { i++; continue; }

    if (/^[RC]/.test(status)) {
      const from = fields[i + 1] ?? '';
      const to = fields[i + 2] ?? '';
      if (inFilter(from) && !inFilter(to)) partners.push(`:(top)${to}`);
      if (inFilter(to) && !inFilter(from)) partners.push(`:(top)${from}`);
      i += 3;
    } else {
      i += 2;
    }
  }

  return partners;
}

async function listUntracked(projectRoot: string, path?: string): Promise<string[]> {
  try {
    const args = ['ls-files', '--others', '--exclude-standard', '-z'];
    if (path) args.push('--', path);
    return (await git(projectRoot, args)).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** Which revision holds the old and the new version of a changed file. */
async function revisionSides(
  args: SmartDiffArgs,
  projectRoot: string,
): Promise<{ root: string; oldSide: Side; newSide: Side }> {
  // Diff paths are relative to the repository root, not to projectRoot.
  let root = projectRoot;
  try {
    root = (await git(projectRoot, ['rev-parse', '--show-toplevel'])).trim() || projectRoot;
  } catch { /* keep projectRoot */ }

  switch (args.scope) {
    case 'staged':
      return { root, oldSide: 'HEAD', newSide: '' };
    case 'commit':
      return { root, oldSide: `${args.ref!}^`, newSide: args.ref! };
    case 'branch': {
      let base: string | null = null;
      try {
        base = (await git(projectRoot, ['merge-base', args.ref!, 'HEAD'])).trim() || null;
      } catch { /* no common ancestor — old side unknown */ }
      return { root, oldSide: base, newSide: 'HEAD' };
    }
    case 'unstaged':
    default:
      // "" = the index (`git show :path`).
      return { root, oldSide: '', newSide: WORKTREE };
  }
}

/** Outline `path` as it is at `side`: on disk, in the index, or at a revision. */
async function outlineAt(
  side: Side,
  path: string,
  root: string,
  astIndex: AstIndexClient,
): Promise<FileStructure | null> {
  if (side === null) return null;

  if (side === WORKTREE) {
    return astIndex.outline(resolve(root, path)).catch(() => null);
  }

  let content: string;
  try {
    content = await git(root, ['show', `${side}:${path}`]);
  } catch {
    return null;
  }

  // The outliner reads files: put the blob in a temp file with the same name
  // (the extension picks the language).
  const dir = await mkdtemp(join(tmpdir(), 'tp-smart-diff-'));
  try {
    const file = join(dir, basename(path));
    await writeFile(file, content);
    return await astIndex.outline(file);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────
// Unified diff parser
// ──────────────────────────────────────────────

/** Undo git's C-style quoting of a path ("caf\303\251.ts" → café.ts). */
function unquotePath(s: string): string {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;

  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  const bytes: number[] = [];

  for (let i = 1; i < s.length - 1;) {
    if (s[i] !== '\\') {
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length;
      continue;
    }

    const next = s[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 2;
    }
  }

  return Buffer.from(bytes).toString('utf8');
}

/** Split "a/<old> b/<new>" from a `diff --git` line; either side may be quoted. */
function parseDiffGitPaths(rest: string): { a: string; b: string } | null {
  let a: string;
  let b: string;

  if (rest.startsWith('"')) {
    let end = 1;
    while (end < rest.length && !(rest[end] === '"' && rest[end - 1] !== '\\')) end++;
    a = unquotePath(rest.slice(0, end + 1));
    b = unquotePath(rest.slice(end + 2));
  } else if (rest.endsWith('"') && rest.lastIndexOf(' "b/') > 0) {
    const cut = rest.lastIndexOf(' "b/');
    a = rest.slice(0, cut);
    b = unquotePath(rest.slice(cut + 1));
  } else {
    // Same path on both sides (the common case) splits exactly in half, even
    // when the path contains spaces or " b/".
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest.slice(half, half + 3) === ' b/' && rest.slice(2, half) === rest.slice(half + 3)) {
      a = rest.slice(0, half);
      b = rest.slice(half + 1);
    } else {
      const m = rest.match(/^(a\/.+?) (b\/.+)$/);
      if (!m) return null;
      a = m[1];
      b = m[2];
    }
  }

  return { a: a.replace(/^a\//, ''), b: b.replace(/^b\//, '') };
}

export function parseUnifiedDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of raw.split('\n')) {
    // Inside a hunk the counts from its @@ header say how many lines belong to
    // it — so "--- x" there is a removed "-- x", never a file header.
    if (current && hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '+') {
        newLeft--;
        current.addedLines++;
        hunk.lines.push(line);
        continue;
      }
      if (c === '-') {
        oldLeft--;
        current.removedLines++;
        hunk.lines.push(line);
        continue;
      }
      if (c === ' ' || line === '') {
        oldLeft--;
        newLeft--;
        hunk.lines.push(line === '' ? ' ' : line);
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      hunk = null; // truncated hunk — treat the line as a header
    }

    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const paths = parseDiffGitPaths(line.slice(11));
      current = {
        path: paths?.b ?? '',
        oldPath: paths && paths.a !== paths.b ? paths.a : undefined,
        addedLines: 0,
        removedLines: 0,
        hunks: [],
        isBinary: false,
        isNew: false,
        isDeleted: false,
      };
      hunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
    } else if (line.startsWith('Binary files') || line === 'GIT binary patch') {
      current.isBinary = true;
    } else if (line.startsWith('rename from ')) {
      current.oldPath = unquotePath(line.slice(12));
    } else if (line.startsWith('rename to ')) {
      current.path = unquotePath(line.slice(10));
    } else if (line.startsWith('@@ ')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      hunk = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
        lines: [],
      };
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      current.hunks.push(hunk);
    }
  }

  if (current) files.push(current);
  return files;
}

// ──────────────────────────────────────────────
// Symbol mapping
// ──────────────────────────────────────────────

interface FlatSymbol { name: string; kind: string; start: number; end: number }

function flattenSymbols(symbols: SymbolInfo[], prefix = ''): FlatSymbol[] {
  const result: FlatSymbol[] = [];
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

/**
 * Changed lines only (no context): added lines by their new line number,
 * removed lines by their old one, plus where each removal sits in the new file.
 */
function changedLines(hunks: DiffHunk[]): { added: Set<number>; removed: Set<number>; removedAt: Set<number> } {
  const added = new Set<number>();
  const removed = new Set<number>();
  const removedAt = new Set<number>();

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added.add(newLine++);
      } else if (line.startsWith('-')) {
        removed.add(oldLine++);
        removedAt.add(newLine);
      } else if (!line.startsWith('\\')) {
        oldLine++;
        newLine++;
      }
    }
  }

  return { added, removed, removedAt };
}

function touches(lines: Set<number>, sym: FlatSymbol): boolean {
  for (const n of lines) {
    if (n >= sym.start && n <= sym.end) return true;
  }
  return false;
}

/**
 * Which symbols a file's hunks change, each with its own change type.
 * `newStructure` outlines the file after the change, `oldStructure` before it;
 * either is null when that side does not exist or could not be outlined.
 */
export function mapHunksToSymbols(
  hunks: DiffHunk[],
  newStructure: FileStructure | null,
  oldStructure: FileStructure | null = null,
): SymbolChange[] {
  const { added, removed, removedAt } = changedLines(hunks);
  const newSymbols = newStructure ? flattenSymbols(newStructure.symbols) : [];
  const oldSymbols = oldStructure ? flattenSymbols(oldStructure.symbols) : [];
  const oldNames = new Set(oldSymbols.map(s => s.name));
  const changes = new Map<string, SymbolChange>();

  for (const sym of newSymbols) {
    // Without the old outline, a removal inside a symbol still changes it.
    const touched = touches(added, sym) || (!oldStructure && touches(removedAt, sym));
    if (!touched || changes.has(sym.name)) continue;

    let changeType: SymbolChange['changeType'];
    if (oldStructure) {
      changeType = oldNames.has(sym.name) ? 'MODIFIED' : 'ADDED';
    } else {
      let allAdded = true;
      for (let n = sym.start; n <= sym.end && allAdded; n++) allAdded = added.has(n);
      changeType = allAdded ? 'ADDED' : 'MODIFIED';
    }

    changes.set(sym.name, { name: sym.name, kind: sym.kind, changeType, lineRange: `[L${sym.start}-${sym.end}]` });
  }

  for (const sym of oldSymbols) {
    if (!touches(removed, sym) || changes.has(sym.name)) continue;

    const survivor = newSymbols.find(s => s.name === sym.name);
    changes.set(sym.name, survivor
      ? { name: sym.name, kind: survivor.kind, changeType: 'MODIFIED', lineRange: `[L${survivor.start}-${survivor.end}]` }
      : { name: sym.name, kind: sym.kind, changeType: 'REMOVED', lineRange: `[was L${sym.start}-${sym.end}]` });
  }

  return Array.from(changes.values());
}

// ──────────────────────────────────────────────
// Output formatter
// ──────────────────────────────────────────────

function scopeLabel(args: SmartDiffArgs): string {
  switch (args.scope) {
    case 'commit': return `commit ${args.ref}`;
    case 'branch': return `branch ${args.ref}...HEAD`;
    default: return args.scope ?? 'unstaged';
  }
}

function emptyMessage(args: SmartDiffArgs): string {
  const where = args.path ? ` under ${args.path}` : '';
  const what = args.scope === 'staged' ? 'nothing is staged'
    : args.scope === 'unstaged' || !args.scope ? 'no changes to tracked files'
      : 'no file changes';

  return `NO CHANGES (${scopeLabel(args)}): ${what}${where}.`;
}

function untrackedLines(untracked: string[]): string[] {
  if (untracked.length === 0) return [];

  const listed = untracked.slice(0, MAX_UNTRACKED_LISTED).join(', ');
  const more = untracked.length > MAX_UNTRACKED_LISTED ? ` +${untracked.length - MAX_UNTRACKED_LISTED} more` : '';
  const files = `${untracked.length} file${untracked.length === 1 ? '' : 's'}`;

  return [`UNTRACKED (not in git diff): ${files} — ${listed}${more}`];
}

function fileBlock(fd: FileDiff, symbols: SymbolChange[] | undefined): string[] {
  const changeLabel = fd.isNew ? ' [NEW]' : fd.isDeleted ? ' [DELETED]' : '';
  const renameLabel = fd.oldPath ? ` (renamed from ${fd.oldPath})` : '';
  const binaryLabel = fd.isBinary ? ' [BINARY]' : '';
  const block = [`${fd.path} (+${fd.addedLines} -${fd.removedLines})${changeLabel}${renameLabel}${binaryLabel}`];

  if (fd.isBinary) {
    block.push('');
    return block;
  }

  for (const sc of (symbols ?? []).slice(0, MAX_SYMBOLS_PER_FILE)) {
    const parens = ['function', 'method'].includes(sc.kind) ? '()' : '';
    block.push(`  ${sc.changeType}: ${sc.name}${parens} ${sc.lineRange}`);
  }
  if (symbols && symbols.length > MAX_SYMBOLS_PER_FILE) {
    block.push(`  … +${symbols.length - MAX_SYMBOLS_PER_FILE} more symbols`);
  }

  // Small diff: include the hunks themselves.
  const totalHunkLines = fd.hunks.reduce((s, h) => s + h.lines.length, 0);
  if (totalHunkLines > 0 && totalHunkLines <= SMALL_DIFF_THRESHOLD) {
    for (const hunk of fd.hunks) {
      block.push(`    @@ L${hunk.newStart}`);
      for (const hl of hunk.lines) {
        block.push(`    ${hl}`);
      }
    }
  } else if (totalHunkLines > SMALL_DIFF_THRESHOLD) {
    block.push(`  (${fd.addedLines + fd.removedLines} lines changed — use read_symbol or read_diff for details)`);
  }

  block.push('');
  return block;
}

function formatSmartDiff(
  files: FileDiff[],
  symbolChanges: Map<string, SymbolChange[]>,
  args: SmartDiffArgs,
  rawTokens: number,
  unmappedFiles: number,
  untracked: string[],
): string {
  const totalAdded = files.reduce((s, f) => s + f.addedLines, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removedLines, 0);

  const lines: string[] = [];
  lines.push(`CHANGES: ${files.length} file${files.length !== 1 ? 's' : ''}, +${totalAdded} -${totalRemoved} (${scopeLabel(args)})`);
  lines.push('');

  let shown = 0;
  for (const fd of files) {
    const block = fileBlock(fd, symbolChanges.get(fd.path));
    if (lines.length + block.length > MAX_OUTPUT_LINES) break;
    lines.push(...block);
    shown++;
  }

  if (shown < files.length) {
    lines.push(`${files.length - shown} of ${files.length} files not shown (output capped at ${MAX_OUTPUT_LINES} lines). Use path to narrow.`);
  }
  if (unmappedFiles > 0) {
    lines.push(`Symbols not mapped for ${unmappedFiles} file${unmappedFiles === 1 ? '' : 's'} past the first ${MAX_FILES}.`);
  }
  lines.push(...untrackedLines(untracked));

  lines.push(`HINT: Use read_symbol(path, symbol) to see full changed code, read_diff(path) for line-level diff.`);
  lines.push(`RAW DIFF: ~${rawTokens} tokens → smart_diff: ~${estimateTokens(lines.join('\n'))} tokens`);

  return lines.join('\n');
}
