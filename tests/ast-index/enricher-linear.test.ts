/**
 * The source masker must stay linear on hostile input: a quote, heredoc or
 * regex literal that never closes must not make every later opener rescan
 * to the end of the line or file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseOutlineText } from '../../src/ast-index/parser.js';
import { buildFileStructure } from '../../src/ast-index/enricher.js';

const LIMIT_MS = 1500;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tp-linear-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Builds the structure of `content` and returns the elapsed milliseconds. */
async function timed(name: string, content: string, outline = ''): Promise<number> {
  const file = join(dir, name);
  await writeFile(file, content);
  const t0 = performance.now();
  await buildFileStructure(file, parseOutlineText(outline));

  return performance.now() - t0;
}

describe('maskSource stays linear', () => {
  it('PHP: 300 KB of escaped apostrophes', async () => {
    expect(await timed('q.php', `<?php\n${"\\'".repeat(150_000)}\n`)).toBeLessThan(LIMIT_MS);
  });

  it('PHP: 20k distinct heredoc openers that never close', async () => {
    const body = Array.from({ length: 20_000 }, (_, k) => `$a = <<<ID${k}\n${'x'.repeat(100)}\n`).join('');
    expect(await timed('h.php', `<?php\n${body}`)).toBeLessThan(LIMIT_MS);
  });

  it('JS: one 300 KB line of escaped apostrophes', async () => {
    expect(await timed('q.js', `${"\\'".repeat(150_000)}\n`)).toBeLessThan(LIMIT_MS);
  });

  it('JS: one line of regex openers whose character class never closes', async () => {
    expect(await timed('r.js', `${'(/['.repeat(100_000)}\n`)).toBeLessThan(LIMIT_MS);
  });

  it('Python: 50k triple quotes that never close', async () => {
    expect(await timed('t.py', `"""\n${'\\"""\n'.repeat(50_000)}`)).toBeLessThan(LIMIT_MS);
  });

  it('still masks what closes after a failed opener of the same kind', async () => {
    const file = join(dir, 'after.ts');
    // the first ' never closes on its line; the later strings and regex still hide their braces
    await writeFile(file, [
      "const a = 1; // it's",
      "const b = x ? '}' : \"{\" + ' ' + 'won\\'t';",
      "function f() {",
      "  const r = /[}]/ + /\\{/;",
      "  return '{';",
      "}",
      '',
    ].join('\n'));
    const s = await buildFileStructure(file, parseOutlineText('  :3 f [function]'));
    expect(s.symbols.map((x) => [x.name, x.location.startLine, x.location.endLine])).toEqual([['f', 3, 6]]);
  });
});
