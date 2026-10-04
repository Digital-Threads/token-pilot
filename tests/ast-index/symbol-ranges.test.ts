/**
 * Real symbol ranges and nesting, computed from the source (W1 items 1-3, 15).
 *
 * The outlines below are recorded `ast-index outline` output (3.50) for the
 * fixtures in tests/fixtures/symbols, so these tests do not need the binary.
 * ast-index prints every symbol at the same indent and gives start lines only.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseOutlineText } from '../../src/ast-index/parser.js';
import { buildFileStructure } from '../../src/ast-index/enricher.js';
import type { FileStructure, SymbolInfo } from '../../src/types.js';

const FIX = join(__dirname, '..', 'fixtures', 'symbols');

async function structureOf(file: string, outline: string[]): Promise<FileStructure> {
  return buildFileStructure(join(FIX, file), parseOutlineText(outline.join('\n')));
}

/** name → [start, end] for top-level symbols. */
function ranges(symbols: SymbolInfo[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const s of symbols) out[s.name] = [s.location.startLine, s.location.endLine];
  return out;
}

function find(symbols: SymbolInfo[], name: string): SymbolInfo {
  const s = symbols.find((x) => x.name === name);
  if (!s) throw new Error(`no symbol ${name} in [${symbols.map((x) => x.name).join(', ')}]`);
  return s;
}

describe('parseOutlineText', () => {
  it('keeps names with spaces (Rust "impl Foo")', () => {
    const entries = parseOutlineText('Outline of a.rs:\n  :5 impl Foo [class]\n  :6 new [function]');
    expect(entries.map((e) => e.name)).toEqual(['impl Foo', 'new']);
  });
});

describe('buildFileStructure — TypeScript', () => {
  const outline = [
    'Outline of tests/fixtures/symbols/sample.ts:',
    '  :4 @Component [annotation]',
    '  :5 Alpha [class]',
    '  :6 n [property]',
    '  :9 run [function]',
    '  :16 value [function]',
    '  :19 outer [function]',
    '  :20 inner [function]',
    '  :23 arrow [function]',
    '  :31 over [function]',
    '  :35 foo [function]',
    '  :41 T [typealias]',
    '  :43 I [interface]',
    '  :47 default [object]',
    '  :51 Component [class]',
  ];

  it('computes real end lines and nests by range', async () => {
    const s = await structureOf('sample.ts', outline);
    expect(ranges(s.symbols)).toMatchObject({
      Alpha: [3, 17],
      outer: [19, 27],
      over: [29, 33],
      foo: [35, 37],
      T: [41, 41],
      I: [43, 45],
      default: [47, 47],
      Component: [51, 51],
    });
    const alpha = find(s.symbols, 'Alpha');
    expect(ranges(alpha.children)).toEqual({ n: [6, 6], run: [8, 14], value: [16, 16] });
    expect(ranges(find(s.symbols, 'outer').children)).toEqual({ inner: [20, 22], arrow: [23, 25] });
  });

  it('attaches decorators and does not list annotations as symbols', async () => {
    const s = await structureOf('sample.ts', outline);
    expect(s.symbols.map((x) => x.name)).not.toContain('@Component');
    expect(find(s.symbols, 'Alpha').decorators).toEqual(['Component({ a: 1 })']);
  });

  it('labels export default {} as a variable, not a function', async () => {
    const s = await structureOf('sample.ts', outline);
    expect(find(s.symbols, 'default').kind).toBe('variable');
    expect(find(s.symbols, 'T').kind).toBe('type');
  });

  it('adds exported lowercase consts that ast-index omits', async () => {
    const s = await structureOf('sample.ts', outline);
    expect(ranges(s.symbols)).toMatchObject({ cfg: [39, 39], lower: [49, 49] });
  });

  const edgeOutline = [
    'Outline of tests/fixtures/symbols/edge.ts:',
    '  :1 UPPER [constant]',
    '  :6 Svc [class]',
    '  :7 constructor [function]',
    '  :12 make [function]',
    '  :16 handler [property]',
    '  :20 field [property]',
    '  :23 Color [enum]',
    '  :28 Base [class]',
    '  :29 run [function]',
    '  :30 helper [function]',
    '  :37 NS [package]',
    '  :38 z [function]',
    '  :45 asyncFn [function]',
    '  :53 afterRegex [function]',
  ];

  it('handles constructors, class fields, generics in return types and regex literals', async () => {
    const s = await structureOf('edge.ts', edgeOutline);
    expect(ranges(s.symbols)).toMatchObject({
      UPPER: [1, 1],
      lowerConst: [2, 2],
      lowerLet: [3, 3],
      Svc: [6, 21],
      Color: [23, 26],
      Base: [28, 31],
      NS: [37, 39],
      gen: [41, 43],
      asyncFn: [45, 47],
      afterRegex: [53, 55],
    });
    expect(ranges(find(s.symbols, 'Svc').children)).toEqual({
      constructor: [7, 10],
      make: [12, 14],
      handler: [16, 18],
      field: [20, 20],
    });
    expect(ranges(find(s.symbols, 'Base').children)).toEqual({ run: [29, 29], helper: [30, 30] });
    expect(find(s.symbols, 'NS').kind).toBe('namespace');
  });

  it('reads visibility/static from the declaration without duplicating it', async () => {
    const s = await structureOf('edge.ts', edgeOutline);
    const svc = find(s.symbols, 'Svc');
    expect(find(svc.children, 'make').static).toBe(true);
    expect(find(find(s.symbols, 'Base').children, 'helper').visibility).toBe('protected');
  });

  it('turns `export default defineConfig(...)` into the default export, not a symbol named defineConfig', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-ranges-'));
    try {
      const file = join(dir, 'vitest.config.ts');
      await writeFile(file, "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {},\n});\n");
      const s = await buildFileStructure(file, parseOutlineText('  :3 defineConfig [function]'));
      expect(s.symbols.map((x) => x.name)).toEqual(['default']);
      expect(ranges(s.symbols)).toEqual({ default: [3, 5] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shows describe/it blocks of a test file as nested symbols', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-ranges-'));
    try {
      const file = join(dir, 'thing.test.ts');
      await writeFile(file, [
        "import { describe, it } from 'vitest';",
        '',
        'function helper() {',
        '  return 1;',
        '}',
        '',
        "describe('Thing', () => {",
        "  it('works', () => {",
        '    helper();',
        '  });',
        '',
        "  it.skip('later', () => {});",
        '});',
        '',
      ].join('\n'));
      const s = await buildFileStructure(file, parseOutlineText('  :3 helper [function]'));
      expect(ranges(s.symbols)).toEqual({ helper: [3, 5], Thing: [7, 13] });
      expect(ranges(find(s.symbols, 'Thing').children)).toEqual({ works: [8, 10], later: [12, 12] });
      expect(find(s.symbols, 'Thing').signature).toContain("describe('Thing'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildFileStructure — other languages', () => {
  it('JavaScript', async () => {
    const s = await structureOf('sample.js', ['  :1 K [class]', '  :2 m [function]', '  :3 n [function]', '  :8 f [function]']);
    expect(ranges(s.symbols)).toEqual({ K: [1, 6], f: [8, 10] });
    expect(ranges(find(s.symbols, 'K').children)).toEqual({ m: [2, 2], n: [3, 5] });
  });

  it('Python: indentation, decorators, nested defs, strings that look like code', async () => {
    const s = await structureOf('sample.py', [
      '  :4 Beta [class]', '  :7 @property [annotation]', '  :8 run [function]', '  :14 stat [function]', '  :18 top [function]',
    ]);
    expect(ranges(s.symbols)).toEqual({ Beta: [4, 15], top: [18, 22] });
    const beta = find(s.symbols, 'Beta');
    expect(ranges(beta.children)).toEqual({ run: [7, 11], stat: [13, 15] });
    expect(find(beta.children, 'run').decorators).toEqual(['property']);
    expect(find(beta.children, 'stat').static).toBe(true);
    expect(ranges(find(beta.children, 'run').children)).toEqual({ nested: [9, 10] });
  });

  it('Go: package is not a function, receivers become Type.Method, doc comments belong to the symbol', async () => {
    const s = await structureOf('sample.go', ['  :1 main [package]', '  :5 Server [class]', '  :10 Start [function]', '  :15 main [function]']);
    expect(s.symbols.map((x) => [x.name, x.kind, x.location.startLine, x.location.endLine])).toEqual([
      ['main', 'namespace', 1, 1],
      ['Server', 'class', 5, 7],
      ['Start', 'method', 9, 13],
      ['main', 'function', 15, 18],
    ]);
    expect(find(s.symbols, 'Start').qualifiedName).toBe('Server.Start');
  });

  it('Rust: impl blocks are named after the type and own their methods', async () => {
    const s = await structureOf('sample.rs', ['  :1 Foo [class]', '  :5 impl Foo [class]', '  :6 new [function]', '  :10 bar [function]', '  :15 main [function]']);
    expect(s.symbols.map((x) => [x.name, x.location.startLine, x.location.endLine])).toEqual([
      ['Foo', 1, 3],
      ['Foo', 5, 13],
      ['main', 15, 18],
    ]);
    expect(ranges(s.symbols[1].children)).toEqual({ new: [6, 8], bar: [10, 12] });
  });

  it('Java: annotations belong to the method, comments with braces are ignored', async () => {
    const s = await structureOf('Sample.java', ['  :3 Sample [class]', '  :4 n [property]', '  :7 toString [function]', '  :11 run [function]']);
    expect(ranges(s.symbols)).toEqual({ Sample: [3, 14] });
    const cls = find(s.symbols, 'Sample');
    expect(ranges(cls.children)).toEqual({ n: [4, 4], toString: [6, 9], run: [11, 13] });
    expect(find(cls.children, 'toString').decorators).toEqual(['Override']);
  });

  it('PHP: namespace statement, class methods with modifiers', async () => {
    const s = await structureOf('sample.php', ['  :2 App [package]', '  :4 Gamma [class]', '  :5 one [function]', '  :9 two [function]', '  :14 helper [function]']);
    expect(ranges(s.symbols)).toEqual({ App: [2, 2], Gamma: [4, 12], helper: [14, 16] });
    const gamma = find(s.symbols, 'Gamma');
    expect(ranges(gamma.children)).toEqual({ one: [5, 7], two: [9, 11] });
    expect(find(gamma.children, 'two')).toMatchObject({ visibility: 'private', static: true });
  });
});

describe('buildFileStructure — imports, exports, docs', () => {
  it('TypeScript: imports, exported symbols, leading doc comments', async () => {
    const s = await structureOf('sample.ts', ['  :5 Alpha [class]', '  :9 run [function]', '  :19 outer [function]', '  :43 I [interface]', '  :47 default [object]', '  :51 Component [class]']);
    expect(s.imports).toEqual([{ source: 'node:fs/promises', specifiers: ['readFile'], isDefault: false, isNamespace: false, line: 1 }]);
    const names = s.exports.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Alpha', 'outer', 'cfg', 'lower', 'default']));
    expect(names).not.toContain('I');
    expect(names).not.toContain('Component');
    expect(s.exports.find((e) => e.name === 'default')!.isDefault).toBe(true);
    expect(find(s.symbols, 'Alpha').doc).toBe('Doc for Alpha');
    expect(find(find(s.symbols, 'Alpha').children, 'run').doc).toBe('run doc');
  });

  it('TypeScript: default, namespace and multi-line named imports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-ranges-'));
    try {
      const file = join(dir, 'imp.ts');
      await writeFile(file, "import a from 'a';\nimport * as b from 'b';\nimport {\n  c,\n  d as e,\n} from 'c';\nimport 'side';\n// import x from 'nope';\nexport { e };\n");
      const s = await buildFileStructure(file, []);
      expect(s.imports.map((i) => [i.source, i.specifiers, i.isDefault, i.isNamespace, i.line])).toEqual([
        ['a', ['a'], true, false, 1],
        ['b', ['b'], false, true, 2],
        ['c', ['c', 'e'], false, false, 3],
        ['side', [], false, false, 7],
      ]);
      expect(s.exports.map((x) => x.name)).toEqual(['e']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Python: imports, public top-level names, docstrings', async () => {
    const s = await structureOf('sample.py', ['  :4 Beta [class]', '  :8 run [function]', '  :18 top [function]']);
    expect(s.imports.map((i) => i.source)).toEqual(['os']);
    expect(s.exports.map((e) => e.name)).toEqual(['Beta', 'top']);
    expect(find(s.symbols, 'Beta').doc).toBe('doc');
  });

  it('Go: capitalised names are exported, doc comments kept', async () => {
    const s = await structureOf('sample.go', ['  :1 main [package]', '  :5 Server [class]', '  :10 Start [function]', '  :15 main [function]']);
    expect(s.imports.map((i) => i.source)).toEqual(['fmt']);
    expect(s.exports.map((e) => e.name)).toEqual(['Server', 'Start']);
    expect(find(s.symbols, 'Start').doc).toBe('Start starts the server.');
  });
});

describe('buildFileStructure — live ast-index on this repo', () => {
  const bin = (() => {
    try {
      return execFileSync('which', ['ast-index'], { encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  })();
  const serverTs = join(__dirname, '..', '..', 'src', 'server.ts');

  it.skipIf(!bin || !existsSync(serverTs))('createServer spans to its own closing brace', async () => {
    const text = execFileSync(bin, ['outline', serverTs], { encoding: 'utf-8' });
    const s = await buildFileStructure(serverTs, parseOutlineText(text));
    const cs = find(s.symbols, 'createServer');
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(serverTs, 'utf-8').split('\n');
    expect(lines[cs.location.startLine - 1]).toMatch(/^export (async )?function createServer\(/);
    expect(lines[cs.location.endLine - 1]).toBe('}');
    expect(cs.location.endLine).toBeGreaterThan(1000);
    // the nested helpers are children, not siblings
    expect(cs.children.map((c) => c.name)).toContain('extractFilePath');
  });
});
