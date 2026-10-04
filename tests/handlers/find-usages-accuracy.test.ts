/**
 * find_usages accuracy: limits and truncation (audit item W4-2) and
 * classification (W4-3). The stub mimics AstIndexClient after it has
 * filtered excluded directories.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFindUsages } from '../../src/handlers/find-usages.js';

type Entry = { path: string; line: number; name?: string; context?: string; signature?: string };

function stub(opts: {
  definitions?: Entry[];
  imports?: Entry[];
  usages?: Entry[];
  search?: Array<{ file: string; line: number; text: string }>;
  refsTruncated?: boolean;
}) {
  const search = Object.assign([...(opts.search ?? [])], {});
  return {
    isDisabled: () => false,
    isOversized: () => false,
    isAvailable: () => true,
    refs: vi.fn(async () => ({
      definitions: opts.definitions ?? [],
      imports: opts.imports ?? [],
      usages: opts.usages ?? [],
      ...(opts.refsTruncated ? { truncated: true } : {}),
    })),
    search: vi.fn(async () => search),
    staleFiles: async () => [],
  } as any;
}

const use = (path: string, line: number, name = 'user'): Entry => ({
  path,
  line,
  name,
  context: `${name}()`,
});

describe('find_usages limits and truncation', () => {
  it('asks ast-index for more than its default 20 per section', async () => {
    const ast = stub({ usages: [use('src/a.ts', 1)] });
    await handleFindUsages({ symbol: 'user' }, ast);

    expect(ast.refs).toHaveBeenCalledWith('user', 500);
    expect(ast.search).toHaveBeenCalledWith('user', { maxResults: 500 });
  });

  it('shows more than 20 usages when limit allows', async () => {
    const usages = Array.from({ length: 40 }, (_, i) => use(`src/f${i}.ts`, 1));
    const result = await handleFindUsages({ symbol: 'user' }, stub({ usages }));

    expect(result.meta.usages).toBe(40);
  });

  it('applies scope before the limit and says what was cut', async () => {
    const usages = [
      ...Array.from({ length: 30 }, (_, i) => use(`src/other/f${i}.ts`, 1)),
      use('src/target/a.ts', 1),
      use('src/target/b.ts', 2),
      use('src/target/c.ts', 3),
    ];
    const result = await handleFindUsages(
      { symbol: 'user', scope: 'src/target', limit: 2 },
      stub({ usages }),
    );
    const text = result.content[0].text;

    expect(result.meta.usages).toBe(2);
    expect(text).toMatch(/showing 2 of 3 usages/);
    expect(text).not.toMatch(/CONFIDENCE: high/);
  });

  it('says when ast-index itself hit its cap', async () => {
    const result = await handleFindUsages(
      { symbol: 'user' },
      stub({ usages: [use('src/a.ts', 1)], refsTruncated: true }),
    );
    const text = result.content[0].text;

    expect(text).toMatch(/more may exist/);
    expect(text).not.toMatch(/CONFIDENCE: high/);
  });
});

describe('find_usages and an index that may be incomplete', () => {
  it('says the index may be stale and drops confidence', async () => {
    const ast = stub({ usages: [use('src/a.ts', 1)], definitions: [{ path: 'src/user.ts', line: 1, name: 'user' }] });
    ast.isStale = () => true;
    const text = (await handleFindUsages({ symbol: 'user' }, ast)).content[0].text;

    expect(text).toMatch(/index may be stale/);
    expect(text).not.toMatch(/CONFIDENCE: high/);
  });

  it('a zero result names what the index never sees', async () => {
    const text = (await handleFindUsages({ symbol: 'user' }, stub({}))).content[0].text;

    expect(text).toMatch(/dot-directories/);
  });
});

describe('find_usages classification', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-find-usages-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps only definitions with the exact name (refs matches by prefix)', async () => {
    const result = await handleFindUsages(
      { symbol: 'handleFind' },
      stub({
        definitions: [
          { path: 'src/find-usages.ts', line: 152, name: 'handleFindUsages', signature: 'export async function handleFindUsages(' },
          { path: 'src/find-unused.ts', line: 27, name: 'handleFindUnused', signature: 'export async function handleFindUnused(' },
        ],
      }),
    );

    expect(result.meta.definitions).toBe(0);
    expect(result.content[0].text).toContain('No usages found');
  });

  it('drops comment lines from usages and counts them', async () => {
    const result = await handleFindUsages(
      { symbol: 'user' },
      stub({
        usages: [use('src/a.ts', 3)],
        search: [
          { file: 'src/a.ts', line: 1, text: '// call user() before render' },
          { file: 'src/b.py', line: 2, text: '# user is cached' },
          { file: 'src/c.ts', line: 4, text: ' * @see user' },
        ],
      }),
    );
    const text = result.content[0].text;

    expect(result.meta.usages).toBe(1);
    expect(text).toMatch(/3 mentions in comments not listed/);
  });

  it('counts comment mentions after the scope, lang and kind filters', async () => {
    const ast = () => stub({
      usages: [use('src/a.ts', 3)],
      search: [
        { file: 'src/a.ts', line: 1, text: '// call user() before render' },
        { file: 'src/b.py', line: 2, text: '# user is cached' },
        { file: 'lib/c.ts', line: 4, text: ' * @see user' },
      ],
    });

    expect((await handleFindUsages({ symbol: 'user', scope: 'src/' }, ast())).content[0].text)
      .toMatch(/2 mentions in comments not listed/);
    expect((await handleFindUsages({ symbol: 'user', lang: 'python' }, ast())).content[0].text)
      .toMatch(/1 mention in comments not listed/);
    expect((await handleFindUsages({ symbol: 'user', kind: 'definitions' }, ast())).content[0].text)
      .not.toMatch(/in comments/);
  });

  it('keeps CONFIDENCE when kind filters out the definitions section', async () => {
    const result = await handleFindUsages(
      { symbol: 'user', kind: 'usages' },
      stub({
        definitions: [{ path: 'src/user.ts', line: 1, name: 'user', signature: 'function user()' }],
        usages: [use('src/a.ts', 3)],
      }),
    );
    const text = result.content[0].text;

    expect(text).toMatch(/CONFIDENCE: high/);
    expect(text).not.toMatch(/target symbol not resolved/);
  });

  it('treats scope as a path prefix, not a substring', async () => {
    const result = await handleFindUsages(
      { symbol: 'user', scope: './src/a/' },
      stub({
        usages: [use('src/a/x.ts', 1), use('lib/src/a/y.ts', 2), use('src/ab/z.ts', 3)],
      }),
    );

    expect(result.meta.files).toEqual(['src/a/x.ts']);
  });

  it('hints at the real `scope` parameter', async () => {
    const usages = Array.from({ length: 25 }, (_, i) => use(`src/f${i}.ts`, 1));
    const full = await handleFindUsages({ symbol: 'user' }, stub({ usages }));
    const list = await handleFindUsages({ symbol: 'user', mode: 'list' }, stub({ usages }));

    for (const r of [full, list]) {
      expect(r.content[0].text).not.toContain('path=');
      expect(r.content[0].text).toContain('scope=');
    }
  });

  it('lang="js" covers .mjs and .cjs', async () => {
    const result = await handleFindUsages(
      { symbol: 'user', lang: 'js' },
      stub({ usages: [use('a.mjs', 1), use('b.cjs', 1), use('c.js', 1), use('d.ts', 1)] }),
    );

    expect(result.meta.files).toEqual(['a.mjs', 'b.cjs', 'c.js']);
  });

  it('lists re-exports and multi-line import members under IMPORTS', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src', 'client.ts'),
      ['import {', '  other,', '  user,', "} from './user.js';", '', 'user();', ''].join('\n'),
    );
    const result = await handleFindUsages(
      { symbol: 'user' },
      stub({
        usages: [use('src/client.ts', 6)],
        search: [
          { file: 'src/index.ts', line: 1, text: "export { user } from './user.js';" },
          { file: 'src/client.ts', line: 3, text: 'user,' },
        ],
      }),
      root,
    );

    expect(result.meta.imports).toBe(2);
    expect(result.meta.usages).toBe(1);
  });
});
