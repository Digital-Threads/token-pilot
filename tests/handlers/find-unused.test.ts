/**
 * find_unused: ast-index `unused-symbols` is a candidate list, not a verdict
 * (59 of 60 were false positives in the audit: same-file calls, member
 * calls, test-only use, callbacks). Every candidate is cross-checked with a
 * word search across the project; anything referenced anywhere is dropped.
 */
import { execFileSync } from 'node:child_process';
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
});
