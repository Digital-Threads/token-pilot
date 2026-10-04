/**
 * smart_diff against real throwaway git repositories (audit 1.0.2, W2 items 1-7).
 *
 * The outline is a fake that reads the file it is handed, so these tests check
 * WHICH content smart_diff outlines (working tree vs the blob at a revision)
 * without depending on ast-index symbol end lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleSmartDiff } from '../../src/handlers/smart-diff.js';
import type { AstIndexClient } from '../../src/ast-index/client.js';
import type { FileStructure } from '../../src/types.js';
import type { SmartDiffArgs } from '../../src/core/validation.js';
import { estimateTokens } from '../../src/core/token-estimator.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const dirs: string[] = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-smart-diff-'));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  const write = (p: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  };
  const remove = (p: string) => unlinkSync(join(dir, p));
  const commit = (msg: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, write, remove, commit };
}

/** Top-level `function name` … closing `}` at column 0. */
function fakeOutline(text: string): FileStructure | null {
  const lines = text.split('\n');
  const symbols: FileStructure['symbols'] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(?:export )?function (\w+)/);
    if (!m) return;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      if (lines[j] === '}') { end = j; break; }
    }
    symbols.push({
      name: m[1],
      kind: 'function',
      location: { startLine: i + 1, endLine: end + 1 },
      children: [],
      decorators: [],
    } as FileStructure['symbols'][number]);
  });
  if (symbols.length === 0) return null;
  return { meta: { lines: lines.length, hasDefaultExport: false, size: text.length, ext: 'ts' }, imports: [], symbols } as unknown as FileStructure;
}

const fakeAst = {
  outline: async (p: string) => {
    try { return fakeOutline(readFileSync(p, 'utf8')); } catch { return null; }
  },
} as unknown as AstIndexClient;

/**
 * A function whose body is `size` lines that all mention `tag`, so changing the
 * tag changes every body line. Bodies are bulky on purpose: below ~30 changed
 * lines smart_diff returns the raw diff (it is cheaper than any summary).
 */
function fn(name: string, tag: string | number, size = 30): string {
  const body = Array.from({ length: size }, (_, i) => `  const v${i} = ${tag};`);
  return [`export function ${name}() {`, ...body, `  return ${tag};`, '}'].join('\n');
}

async function diff(dir: string, args: Partial<SmartDiffArgs> = {}) {
  const r = await handleSmartDiff({ scope: 'unstaged', ...args } as SmartDiffArgs, dir, fakeAst);
  return { text: r.content[0].text, rawTokens: r.rawTokens };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ─── item 1: hunk lines starting with -- / ++ ────────────────────────────────

describe('smart_diff — hunk lines that start with -- or ++', () => {
  it('keeps a removed "-- comment" and an added "++ x" line and counts them', async () => {
    const r = makeRepo();
    const rows = (word: string) => Array.from({ length: 20 }, (_, i) => `-- ${word} ${i}`).join('\n');
    r.write('q.sql', `select 1;\n${rows('comment')}\nselect 2;\n`);
    r.write('c.txt', 'a\nb\n');
    r.commit('init');
    r.write('q.sql', `select 1;\n${rows('changed')}\nselect 2;\n`);
    r.write('c.txt', 'a\n' + Array.from({ length: 20 }, (_, i) => `++ counter ${i}`).join('\n') + '\nb\n');

    const { text } = await diff(r.dir);
    expect(text).toContain('q.sql (+20 -20)');
    expect(text).toContain('c.txt (+20 -0)');
    expect(text).toContain('CHANGES: 2 files, +40 -20');
  });
});

// ─── item 2: AFFECTED SYMBOLS ───────────────────────────────────────────────

describe('smart_diff — symbol mapping', () => {
  it('marks each symbol by its own change: modified vs added', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.write('a.ts', fn('alpha', 2) + '\n\n' + fn('beta', 3) + '\n');

    const { text } = await diff(r.dir);
    expect(text).toMatch(/MODIFIED: alpha\(\)/);
    expect(text).toMatch(/ADDED: beta\(\)/);
    expect(text).not.toMatch(/MODIFIED: beta/);
  });

  it('ignores context lines: a symbol next to the change is not reported', async () => {
    const r = makeRepo();
    // gamma sits one line below alpha — inside the 3 context lines of the hunk.
    const v1 = fn('alpha', 1) + '\n' + fn('gamma', 0) + '\n';
    const v2 = fn('alpha', 2) + '\n' + fn('gamma', 0) + '\n';
    r.write('a.ts', v1);
    r.commit('init');
    r.write('a.ts', v2);

    const { text } = await diff(r.dir);
    expect(text).toMatch(/MODIFIED: alpha\(\)/);
    expect(text).not.toMatch(/gamma/);
  });

  it('reports a symbol removed from a file', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n\n' + fn('doomed', 2) + '\n');
    r.commit('init');
    r.write('a.ts', fn('alpha', 1) + '\n');

    const { text } = await diff(r.dir);
    expect(text).toMatch(/REMOVED: doomed\(\)/);
    expect(text).not.toMatch(/alpha/);
  });

  it('reports the symbols of a deleted file as removed', async () => {
    const r = makeRepo();
    r.write('gone.ts', fn('vanish', 1) + '\n');
    r.write('keep.ts', 'x\n');
    const base = r.commit('init');
    r.remove('gone.ts');
    const sha = r.commit('delete gone.ts');

    const { text } = await diff(r.dir, { scope: 'commit', ref: sha });
    expect(base).not.toBe(sha);
    expect(text).toContain('[DELETED]');
    expect(text).toMatch(/REMOVED: vanish\(\)/);
  });

  it('commit scope outlines the file at that commit, not the working tree', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.write('a.ts', fn('alpha', 2) + '\n');
    const sha = r.commit('change alpha');
    // Working tree moves on: alpha is gone, something else sits on its lines.
    r.write('a.ts', fn('omega', 9) + '\n');

    const { text } = await diff(r.dir, { scope: 'commit', ref: sha });
    expect(text).toMatch(/MODIFIED: alpha\(\)/);
    expect(text).not.toMatch(/omega/);
  });

  it('branch scope compares HEAD with the merge base, not the working tree', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.git('branch', 'base');
    r.write('a.ts', fn('alpha', 2) + '\n\n' + fn('beta', 3) + '\n');
    r.commit('work on HEAD');
    r.write('a.ts', fn('omega', 9) + '\n');

    const { text } = await diff(r.dir, { scope: 'branch', ref: 'base' });
    expect(text).toMatch(/MODIFIED: alpha\(\)/);
    expect(text).toMatch(/ADDED: beta\(\)/);
    expect(text).not.toMatch(/omega/);
  });

  it('staged scope outlines the staged version, not the working tree', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.write('a.ts', fn('alpha', 2) + '\n');
    r.git('add', 'a.ts');
    r.write('a.ts', fn('omega', 9) + '\n');

    const { text } = await diff(r.dir, { scope: 'staged' });
    expect(text).toMatch(/MODIFIED: alpha\(\)/);
    expect(text).not.toMatch(/omega/);
  });
});

// ─── item 3: merge commits ──────────────────────────────────────────────────

describe('smart_diff — merge commits', () => {
  it('shows what a merge brought in (first-parent diff), not NO CHANGES', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.git('checkout', '-q', '-b', 'feature');
    r.write('b.ts', fn('beta', 2) + '\n');
    r.commit('add beta');
    r.git('checkout', '-q', 'main');
    r.write('c.ts', 'c\n');
    r.commit('main moves on');
    r.git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    const merge = r.git('rev-parse', 'HEAD').trim();

    const { text } = await diff(r.dir, { scope: 'commit', ref: merge });
    expect(text).not.toMatch(/NO CHANGES/);
    expect(text).toContain('b.ts');
    expect(text).toMatch(/ADDED: beta\(\)/);
  });

  // `--diff-merges` arrived in git 2.31; older git rejects it outright.
  it.skipIf(process.platform === 'win32')('works on git older than 2.31, which has no --diff-merges', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.git('checkout', '-q', '-b', 'feature');
    r.write('b.ts', fn('beta', 2) + '\n');
    r.commit('add beta');
    r.git('checkout', '-q', 'main');
    r.write('c.ts', 'c\n');
    r.commit('main moves on');
    r.git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    const merge = r.git('rev-parse', 'HEAD').trim();

    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = mkdtempSync(join(tmpdir(), 'tp-old-git-'));
    dirs.push(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nfor a in "$@"; do case "$a" in --diff-merges*) echo "fatal: unrecognized argument: $a" >&2; exit 128;; esac; done\n' +
        `exec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const whole = await diff(r.dir, { scope: 'commit', ref: merge });
      expect(whole.text).not.toMatch(/failed/);
      expect(whole.text).toMatch(/ADDED: beta\(\)/);
      expect(whole.text).not.toContain('c.ts');

      const scoped = await diff(r.dir, { scope: 'commit', ref: merge, path: 'b.ts' });
      expect(scoped.text).toMatch(/ADDED: beta\(\)/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

// ─── item 4: honest messages ────────────────────────────────────────────────

describe('smart_diff — messages', () => {
  it('a bad ref is reported as a git error, not "Not a git repository"', async () => {
    const r = makeRepo();
    r.write('a.ts', 'x\n');
    r.commit('init');
    const { text } = await diff(r.dir, { scope: 'commit', ref: 'no-such-ref' });
    expect(text).not.toMatch(/Not a git repository/);
    expect(text).toMatch(/no-such-ref/);
  });

  it('a directory outside git still says "Not a git repository"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-smart-diff-nogit-'));
    dirs.push(dir);
    const { text } = await diff(dir);
    expect(text).toMatch(/Not a git repository/);
  });

  it('empty staged diff does not claim the working tree is clean', async () => {
    const r = makeRepo();
    r.write('a.ts', 'x\n');
    r.commit('init');
    r.write('a.ts', 'y\n'); // unstaged change exists
    const { text } = await diff(r.dir, { scope: 'staged' });
    expect(text).toMatch(/NO CHANGES \(staged\)/);
    expect(text).not.toMatch(/working tree is clean/);
  });

  it('empty commit-scope diff for a path does not claim the working tree is clean', async () => {
    const r = makeRepo();
    r.write('a.ts', 'x\n');
    r.write('b.ts', 'x\n');
    r.commit('init');
    r.write('a.ts', 'y\n');
    const sha = r.commit('touch a');
    const { text } = await diff(r.dir, { scope: 'commit', ref: sha, path: 'b.ts' });
    expect(text).toMatch(/NO CHANGES/);
    expect(text).not.toMatch(/working tree is clean/);
    expect(text).toContain('b.ts');
  });

  it('untracked files are shown, and their presence is not called "clean"', async () => {
    const r = makeRepo();
    r.write('a.ts', 'x\n');
    r.commit('init');
    r.write('fresh.ts', 'new\n');
    const { text } = await diff(r.dir);
    expect(text).toContain('fresh.ts');
    expect(text).toMatch(/untracked/i);
    expect(text).not.toMatch(/working tree is clean/);
  });

  it('untracked files are listed next to tracked changes too', async () => {
    const r = makeRepo();
    r.write('a.ts', fn('alpha', 1) + '\n');
    r.commit('init');
    r.write('a.ts', fn('alpha', 2) + '\n');
    r.write('fresh.ts', 'new\n');
    const { text } = await diff(r.dir);
    expect(text).toContain('a.ts');
    expect(text).toMatch(/UNTRACKED.*fresh\.ts/s);
  });

  it('a path filter on a renamed file\'s old name shows the rename, not [DELETED]', async () => {
    const r = makeRepo();
    const body = fn('alpha', 1) + '\n';
    r.write('old-name.ts', body);
    r.commit('init');
    r.git('mv', 'old-name.ts', 'new-name.ts');
    r.write('new-name.ts', body.replace('return 1;', 'return 2;'));
    const sha = r.commit('rename');

    const { text } = await diff(r.dir, { scope: 'commit', ref: sha, path: 'old-name.ts' });
    // Small diff → may come back raw; either way it is a rename, not a deletion.
    expect(text).not.toContain('[DELETED]');
    expect(text).not.toContain('deleted file mode');
    expect(text).toContain('new-name.ts');
    expect(text).toMatch(/renamed? from old-name\.ts/);
  });
});

// ─── item 5: paths with spaces and non-ASCII ────────────────────────────────

describe('smart_diff — unusual paths', () => {
  it('handles spaces, non-ASCII and binary files', async () => {
    const r = makeRepo();
    r.write('my file.ts', fn('spaced', 1) + '\n');
    r.write('café.ts', fn('accent', 1) + '\n');
    r.write('img.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
    r.commit('init');
    r.write('my file.ts', fn('spaced', 2) + '\n');
    r.write('café.ts', fn('accent', 2) + '\n');
    r.write('img.bin', Buffer.from([0, 9, 9, 9, 0, 254]));

    const { text } = await diff(r.dir);
    expect(text).toContain('my file.ts (+31 -31)');
    expect(text).toContain('café.ts (+31 -31)');
    expect(text).toMatch(/MODIFIED: spaced\(\)/);
    expect(text).toMatch(/MODIFIED: accent\(\)/);
    expect(text).toMatch(/img\.bin .*\[BINARY\]/);
    expect(text).not.toMatch(/\\303/);
  });
});

// ─── items 6 + 7: size caps and raw fallback ────────────────────────────────

describe('smart_diff — large and small diffs', () => {
  let r: ReturnType<typeof makeRepo>;
  const FILES = 120;

  beforeAll(() => {
    r = makeRepo();
    for (let i = 0; i < FILES; i++) {
      const fns = [0, 1, 2, 3].map(k => fn(`f${i}_${k}`, 1)).join('\n\n');
      r.write(`src/m${String(i).padStart(3, '0')}.ts`, fns + '\n');
    }
    r.commit('init');
    for (let i = 0; i < FILES; i++) {
      const fns = [0, 1, 2, 3].map(k => fn(`f${i}_${k}`, 2)).join('\n\n');
      r.write(`src/m${String(i).padStart(3, '0')}.ts`, fns + '\n');
    }
  });

  it('caps the output once and says how many files are not shown, consistently', async () => {
    const { text } = await diff(r.dir);
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(520);

    const headers = lines.filter(l => /^src\/m\d{3}\.ts \(/.test(l)).length;
    const note = text.match(/(\d+) of (\d+) files (?:are )?not shown/);
    expect(note, text.slice(-400)).not.toBeNull();
    expect(Number(note![2])).toBe(FILES);
    expect(headers + Number(note![1])).toBe(FILES);
    expect(text).not.toMatch(/more files\)/); // the old, contradictory second note
  });

  it('counts only changed lines, not context, in the "lines changed" note', async () => {
    const big = makeRepo();
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    big.write('big.txt', before.join('\n') + '\n');
    big.commit('init');
    const after = before.map((l, i) => (i >= 10 && i < 50 ? `${l} changed` : l));
    big.write('big.txt', after.join('\n') + '\n');
    const { text } = await diff(big.dir);
    expect(text).toContain('big.txt (+40 -40)');
    expect(text).toMatch(/\(80 lines changed/);
  });

  it('a tiny diff never costs more tokens than the raw diff', async () => {
    const t = makeRepo();
    t.write('x.txt', 'a\n');
    t.commit('init');
    t.write('x.txt', 'b\n');
    const { text, rawTokens } = await diff(t.dir);
    expect(estimateTokens(text)).toBeLessThanOrEqual(rawTokens);
    expect(text).toContain('+b');
  });
});
