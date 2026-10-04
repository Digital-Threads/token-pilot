/**
 * explore's blast radius comes from ast-index's graph, whose "callers" are
 * the nearest named symbol above a call site: a nested helper declared
 * earlier in the same function, a constant in a test file, or any function
 * calling a same-named method (`xs.find(...)` for a `find` function).
 * Each caller is kept only when its own body references a ranked symbol.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleExplore } from '../../src/handlers/explore.js';

const FILES: Record<string, string> = {
  'src/server.ts': [
    'export function createServer() {',
    '  const recordWithTrace = (x: unknown) => {',
    '    console.log(x);',
    '  };',
    '  return async (name: string) => {',
    '    switch (name) {',
    "      case 'find_usages':",
    '        return handleFindUsages(1);',
    '    }',
    '  };',
    '}',
    '',
  ].join('\n'),
  'src/real.ts': 'export function realCaller() {\n  return handleFindUsages(2);\n}\n',
  'src/arr.ts': 'export function usesArrayFind(xs: number[]) {\n  return xs.find((x) => x > 1);\n}\n',
  'src/direct.ts': 'export function callsFind() {\n  return find(3);\n}\n',
};

describe('explore blast radius', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-explore-'));
    await mkdir(join(root, 'src'));
    for (const [rel, content] of Object.entries(FILES)) {
      await writeFile(join(root, rel), content);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stub = (result: object) => ({ explore: async () => result }) as any;

  it('keeps a caller only when its body references a ranked symbol', async () => {
    const result = await handleExplore(
      { query: 'handleFindUsages' },
      root,
      stub({
        query: 'handleFindUsages',
        dominantLanguage: 'typescript',
        symbols: [{ name: 'handleFindUsages', kind: 'function', path: 'src/find-usages.ts', line: 1, score: 1000, vendor: false }],
        files: [],
        neighbours: [
          { name: 'recordWithTrace', kind: 'function', path: 'src/server.ts', line: 2, link: 'caller' },
          { name: 'realCaller', kind: 'function', path: 'src/real.ts', line: 1, link: 'caller' },
          { name: '../src/find-usages.js', kind: 'import', path: 'src/real.ts', line: 1, link: 'caller' },
        ],
        tests: [{ source: 'src/server.ts', tests: [] }],
      }),
    );
    const text = result.content[0].text;

    expect(text).toContain('realCaller');
    expect(text).not.toContain('recordWithTrace');
    expect(text).not.toContain('import ../src/find-usages.js');
    expect(text).toMatch(/2 graph neighbours not shown/);
    expect(text).not.toContain('## Tests');
  });

  it('a method call on another object does not call a same-named function', async () => {
    const result = await handleExplore(
      { query: 'find' },
      root,
      stub({
        query: 'find',
        dominantLanguage: 'typescript',
        symbols: [{ name: 'find', kind: 'function', path: 'src/find.ts', line: 1, score: 900, vendor: false }],
        files: [],
        neighbours: [
          { name: 'usesArrayFind', kind: 'function', path: 'src/arr.ts', line: 1, link: 'caller' },
          { name: 'callsFind', kind: 'function', path: 'src/direct.ts', line: 1, link: 'caller' },
        ],
        tests: [],
      }),
    );
    const text = result.content[0].text;

    expect(text).toContain('callsFind');
    expect(text).not.toContain('usesArrayFind');
  });

  it('import statements are not ranked as symbols', async () => {
    const result = await handleExplore(
      { query: 'x' },
      root,
      stub({
        query: 'x',
        dominantLanguage: 'typescript',
        symbols: [
          { name: 'x', kind: 'function', path: 'src/x.ts', line: 1, score: 10, vendor: false },
          { name: '../../src/x.js', kind: 'import', path: 'tests/x.test.ts', line: 2, score: 3, vendor: false },
        ],
        files: [],
        neighbours: [],
        tests: [],
      }),
    );

    expect(result.content[0].text).not.toContain('import ../../src/x.js');
    expect(result.meta.symbolCount).toBe(1);
  });
});
