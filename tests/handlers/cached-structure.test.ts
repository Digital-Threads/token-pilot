/**
 * W1 item 4: smart_read's small-file pass-through and read_for_edit cache a
 * placeholder structure (symbols: []) as the read_diff baseline. Symbol
 * tools must not trust it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSmartRead } from '../../src/handlers/smart-read.js';
import { handleReadSymbol } from '../../src/handlers/read-symbol.js';
import { handleReadSymbols } from '../../src/handlers/read-symbols.js';
import { handleReadForEdit } from '../../src/handlers/read-for-edit.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';
import { SymbolResolver } from '../../src/core/symbol-resolver.js';
import { buildFileStructure } from '../../src/ast-index/enricher.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('placeholder structures in the file cache', () => {
  let dir: string;
  let astIndex: any;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tp-cached-structure-'));
    astIndex = {
      outline: vi.fn(async (p: string) =>
        buildFileStructure(p, [
          { name: 'alpha', kind: 'function', start_line: 1, end_line: 0 },
          { name: 'beta', kind: 'function', start_line: 5, end_line: 0 },
        ])),
      symbol: vi.fn(async () => null),
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, extra = 0) =>
    writeFile(
      join(dir, name),
      ['function alpha() {', '  return 1;', '}', '', 'function beta() {', '  return 2;', '}', ...Array(extra).fill('// pad')].join('\n'),
    );

  it('read_symbol and read_symbols find symbols after a small-file smart_read', async () => {
    await write('small.ts');
    const cache = new FileCache();
    await handleSmartRead({ path: 'small.ts' }, dir, astIndex, cache, new ContextRegistry(), DEFAULT_CONFIG);

    const one = await handleReadSymbol({ path: 'small.ts', symbol: 'beta' }, dir, new SymbolResolver(astIndex), cache, new ContextRegistry(), astIndex, false);
    expect(one.content[0].text).toContain('SYMBOL: beta');

    const many = await handleReadSymbols({ path: 'small.ts', symbols: ['alpha', 'beta'] }, dir, new SymbolResolver(astIndex), cache, new ContextRegistry(), astIndex, false);
    expect(many.content[0].text).not.toContain('not found');
  });

  it('read_for_edit batch finds symbols after a placeholder was cached', async () => {
    await write('edit.ts');
    const cache = new FileCache();
    await handleReadForEdit({ path: 'edit.ts', line: 2 }, dir, new SymbolResolver(astIndex), cache, new ContextRegistry(), astIndex);

    const batch = await handleReadForEdit({ path: 'edit.ts', symbols: ['alpha', 'beta'] }, dir, new SymbolResolver(astIndex), cache, new ContextRegistry(), astIndex);
    expect(batch.content[0].text).not.toContain('NOT FOUND');
  });

  it('smart_read shows the real outline after read_for_edit cached a placeholder', async () => {
    await write('big.ts', 300);
    const cache = new FileCache();
    await handleReadForEdit({ path: 'big.ts', line: 2 }, dir, new SymbolResolver(astIndex), cache, new ContextRegistry(), astIndex);

    const out = await handleSmartRead({ path: 'big.ts' }, dir, astIndex, cache, new ContextRegistry(), DEFAULT_CONFIG);
    expect(out.content[0].text).toContain('beta');
  });
});
