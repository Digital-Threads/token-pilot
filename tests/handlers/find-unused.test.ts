/**
 * find_unused: ast-index `unused-symbols` is a candidate list, not a verdict
 * (59 of 60 were false positives in the audit: same-file calls, member
 * calls, test-only use, callbacks). Every candidate is cross-checked with a
 * word search across the project; anything referenced anywhere is dropped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFindUnused } from '../../src/handlers/find-unused.js';

type Cand = { name: string; kind: string; path: string; line: number; signature?: string };

function stub(root: string, candidates: Cand[], files: string[] = []) {
  return {
    isDisabled: () => false,
    isOversized: () => false,
    getProjectRoot: () => root,
    unusedSymbols: vi.fn(async () => candidates),
    outline: async () => null,
    listFiles: async () => files,
  } as any;
}

async function project(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
}

const FILES = {
  'src/a.ts': 'export function testedOnly() {}\n',
  'src/b.ts': 'function sameFile() {}\nexport const run = () => sameFile();\n',
  'src/c.ts': 'export function reallyDead() {}\nexport function viaMember() {}\n',
  'src/d.ts': 'import * as c from "./c.js";\nsetTimeout(c.viaMember, 1);\n',
  'tests/a.test.ts': 'import { testedOnly } from "../src/a.js";\ntestedOnly();\n',
  'node_modules/x/index.d.ts': 'export declare function reallyDead(): void;\n',
};

const CANDIDATES: Cand[] = [
  { name: 'testedOnly', kind: 'function', path: 'src/a.ts', line: 1, signature: 'export function testedOnly() {}' },
  { name: 'sameFile', kind: 'function', path: 'src/b.ts', line: 1, signature: 'function sameFile() {}' },
  { name: 'reallyDead', kind: 'function', path: 'src/c.ts', line: 1, signature: 'export function reallyDead() {}' },
  { name: 'viaMember', kind: 'function', path: 'src/c.ts', line: 2, signature: 'export function viaMember() {}' },
];

describe('handleFindUnused', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-find-unused-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('drops candidates referenced anywhere (git repo: git grep incl. untracked files)', async () => {
    await project(root, FILES);
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, '.gitignore'), 'node_modules\n');

    const result = await handleFindUnused({}, stub(root, CANDIDATES));
    const text = result.content[0].text;

    expect(text).toContain('reallyDead');
    expect(text).not.toMatch(/testedOnly|sameFile|viaMember/);
    expect(text).toMatch(/3 .*referenced/);
    expect(result.meta.files).toEqual(['src/c.ts']);
  });

  it('drops referenced candidates without git, scanning the indexed files', async () => {
    await project(root, FILES);
    const files = Object.keys(FILES).filter((f) => !f.startsWith('node_modules'));

    const result = await handleFindUnused({}, stub(root, CANDIDATES, files));
    const text = result.content[0].text;

    expect(text).toContain('reallyDead');
    expect(text).not.toMatch(/testedOnly|sameFile|viaMember/);
  });

  it('reports nothing when the cross-check cannot run', async () => {
    const result = await handleFindUnused({}, stub(root, CANDIDATES, []));
    const text = result.content[0].text;

    expect(text).not.toContain('reallyDead');
    expect(text).toMatch(/could not verify/i);
  });

  it('export_only keeps exported symbols by the language rule, not by capital letter', async () => {
    await project(root, {
      'src/e.ts': 'export function lowerExported() {}\ninterface InternalShape {}\n',
      'src/p.py': 'def public_fn():\n    pass\n\ndef _private_fn():\n    pass\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const ast = stub(root, [
      { name: 'lowerExported', kind: 'function', path: 'src/e.ts', line: 1, signature: 'export function lowerExported() {}' },
      { name: 'InternalShape', kind: 'interface', path: 'src/e.ts', line: 2, signature: 'interface InternalShape {}' },
      { name: 'public_fn', kind: 'function', path: 'src/p.py', line: 1, signature: 'def public_fn():' },
      { name: '_private_fn', kind: 'function', path: 'src/p.py', line: 4, signature: 'def _private_fn():' },
    ]);

    const text = (await handleFindUnused({ export_only: true }, ast)).content[0].text;

    expect(text).toContain('lowerExported');
    expect(text).toContain('public_fn');
    expect(text).not.toContain('InternalShape');
    expect(text).not.toContain('_private_fn');
    expect(ast.unusedSymbols.mock.calls[0][0].exportOnly).toBeFalsy();
  });

  it('says when the candidate list from ast-index was capped', async () => {
    await project(root, { 'src/c.ts': 'export function reallyDead() {}\n' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    // The client flags a list that reached the requested limit before it
    // dropped node_modules entries (they crowd out project symbols).
    const ast = stub(root, Object.assign([CANDIDATES[2]], { truncated: true }));

    const text = (await handleFindUnused({}, ast)).content[0].text;

    expect(text).toMatch(/more may exist/);
    expect(ast.unusedSymbols.mock.calls[0][0].limit).toBeGreaterThanOrEqual(10_000);
  });

  it.skipIf(process.platform === 'win32')('finds the same references as a git word search, without running git grep', async () => {
    // one-letter names make `git grep -w -F` slow: every letter matches, then -w rejects it
    await project(root, {
      '.gitignore': 'ignored/\n',
      'src/a.ts': [
        'export function x() {}',
        'export function longName() {}',
        'export function reallyDead() {}',
        'export function ignoredOnly() {}',
        'export function binOnly() {}',
        'export function dollarName() {}',
        '',
      ].join('\n'),
      'src/use.ts': 'const v = x() + xx + x1;\n',
      'src/lib.rs': 'struct Foo;\nimpl Foo {\n}\n',
      'src/other.rs': '// see impl Foo\n',
      'src/p.php': '<?php echo $dollarName;\n',
      'ignored/x.ts': 'ignoredOnly();\n',
    });
    await writeFile(join(root, 'src', 'blob.bin'), Buffer.from('\u0000binOnly\n'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    await writeFile(join(root, 'src', 'new.ts'), 'longName();\n'); // untracked, not ignored

    const cands: Cand[] = [
      ...['x', 'longName', 'reallyDead', 'ignoredOnly', 'binOnly', 'dollarName'].map((name, i) => (
        { name, kind: 'function', path: 'src/a.ts', line: i + 1, signature: `export function ${name}() {}` })),
      { name: 'impl Foo', kind: 'class', path: 'src/lib.rs', line: 2, signature: 'impl Foo {' },
    ];

    // reference answer: the word search the handler used to run
    const grep = git('grep', '--untracked', '-I', '-n', '-o', '-w', '-F', ...cands.flatMap((c) => ['-e', c.name]));
    const defs = new Set(cands.map((c) => `${c.path}:${c.line}:${c.name}`));
    const used = new Set(grep.split('\n').filter((r) => r && !defs.has(r)).map((r) => r.split(':').slice(2).join(':')));
    const expected = cands.map((c) => c.name).filter((n) => !used.has(n)).sort();
    expect(expected).toEqual(['binOnly', 'ignoredOnly', 'reallyDead']);

    // a git that logs its subcommands
    const bin = join(root, '.fakebin');
    await mkdir(bin);
    const log = join(bin, 'log');
    const real = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    await writeFile(join(bin, 'git'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let text: string;
    try {
      text = (await handleFindUnused({}, stub(root, cands))).content[0].text;
    } finally {
      process.env.PATH = path;
    }

    const reported = cands.map((c) => c.name).filter((n) => new RegExp(`(function|class) ${n} \\(L`).test(text)).sort();
    expect(reported).toEqual(expected);
    expect(readFileSync(log, 'utf-8')).not.toMatch(/^grep$/m);
  });
});
