/**
 * W1 item 14: line counts, clamped ranges, budgets and claims that match
 * what was actually returned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSmartRead } from '../../src/handlers/smart-read.js';
import { handleReadRange } from '../../src/handlers/read-range.js';
import { handleReadSymbols } from '../../src/handlers/read-symbols.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';
import { SymbolResolver } from '../../src/core/symbol-resolver.js';
import { buildFileStructure } from '../../src/ast-index/enricher.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { countsAsFullFileRead } from '../../src/server.js';

describe('honest counts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tp-honest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a 4-line file ending in a newline has 4 lines (smart_read and the structure)', async () => {
    const file = join(dir, 'four.ts');
    await writeFile(file, 'export function a() {\n  return 1;\n}\nexport const b = 2;\n');

    const out = await handleSmartRead({ path: 'four.ts' }, dir, { outline: async () => null } as any, new FileCache(), new ContextRegistry(), DEFAULT_CONFIG);
    expect(out.content[0].text).toContain('(4 lines');

    const s = await buildFileStructure(file, []);
    expect(s.meta.lines).toBe(4);
  });

  it('read_range shows and tracks the clamped range', async () => {
    await writeFile(join(dir, 'r.ts'), 'a\nb\nc\nd\n');
    const registry = new ContextRegistry();
    const out = await handleReadRange({ path: 'r.ts', start_line: 2, end_line: 999 }, dir, new FileCache(), registry);
    const text = out.content[0].text;
    expect(text).toContain('[L2-4]');
    expect(text).not.toContain('999]');
    expect(registry.getLoaded(join(dir, 'r.ts'))![0]).toMatchObject({ startLine: 2, endLine: 4 });
  });

  it('smart_read compact view stays within max_tokens', async () => {
    const file = join(dir, 'many.ts');
    const body = Array.from({ length: 400 }, (_, i) => `export function fn${i}() {\n  return ${i};\n}`).join('\n');
    await writeFile(file, body);
    const entries = Array.from({ length: 400 }, (_, i) => ({ name: `fn${i}`, kind: 'function', start_line: i * 3 + 1, end_line: 0 }));
    const astIndex = { outline: async (p: string) => buildFileStructure(p, entries) } as any;

    const out = await handleSmartRead({ path: 'many.ts', max_tokens: 300 }, dir, astIndex, new FileCache(), new ContextRegistry(), DEFAULT_CONFIG);
    const text = out.content[0].text;
    expect(text.length / 4).toBeLessThanOrEqual(400); // ~300 tokens, small slack for the note
    expect(text).toMatch(/more symbols/);
  });

  it('smart_read of a large JSON file respects max_tokens', async () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) obj[`key${i}`] = { value: i, label: `label ${i}`.repeat(3) };
    await writeFile(join(dir, 'big.json'), JSON.stringify(obj, null, 2));

    const out = await handleSmartRead({ path: 'big.json', max_tokens: 200 }, dir, { outline: async () => null } as any, new FileCache(), new ContextRegistry(), DEFAULT_CONFIG);
    const text = out.content[0].text;
    expect(text.length / 4).toBeLessThanOrEqual(300);
    expect(text).toMatch(/max_tokens/);
  });

  it('read_symbols does not claim symbols are in context when none resolved', async () => {
    await writeFile(join(dir, 's.ts'), 'export const a = 1;\n');
    const astIndex = { outline: async () => null, symbol: async () => null } as any;
    const out = await handleReadSymbols({ path: 's.ts', symbols: ['nope', 'nada'] }, dir, new SymbolResolver(astIndex), new FileCache(), new ContextRegistry(), astIndex, false);
    expect(out.content[0].text).not.toContain('now in your context');
  });

  it('only a smart_read that returned the whole file counts as a full-file read', () => {
    expect(countsAsFullFileRead('smart_read', 1000, 1000)).toBe(true);
    expect(countsAsFullFileRead('smart_read', 150, 1000)).toBe(false); // an outline
    expect(countsAsFullFileRead('read_symbol', 1000, 1000)).toBe(false);
  });
});
