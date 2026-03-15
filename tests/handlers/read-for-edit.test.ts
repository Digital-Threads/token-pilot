import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadForEdit } from '../../src/handlers/read-for-edit.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadForEdit', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-edit-'));
    filePath = join(tempDir, 'file.ts');
    await writeFile(filePath, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires either symbol or line', async () => {
    const result = await handleReadForEdit(
      { path: 'file.ts' },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );

    expect(result.content[0].text).toContain('Either "symbol" or "line" must be provided');
  });

  it('returns a line-based raw edit context', async () => {
    const result = await handleReadForEdit(
      { path: 'file.ts', line: 10, context: 2 },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );

    expect(result.content[0].text).toContain('TARGET: line 10');
    expect(result.content[0].text).toContain('SHOWING: L8-12');
    expect(result.content[0].text).toContain('For Read requirement: Read("file.ts", offset=8, limit=5)');
  });

  it('limits large symbols and tracks edit context', async () => {
    const registry = new ContextRegistry();
    const result = await handleReadForEdit(
      { path: 'file.ts', symbol: 'BigClass' },
      tempDir,
      {
        resolve: async () => ({
          startLine: 20,
          endLine: 95,
        }),
      } as any,
      new FileCache(),
      registry,
      {
        outline: async () => ({ symbols: [] }),
      } as any,
    );

    expect(result.content[0].text).toContain('showing first 60 of 76 lines');
    expect(result.content[0].text).toContain('SHOWING: L15-84');
    expect(registry.isSymbolLoaded(filePath, 'BigClass')).toBe(true);
  });

  it('reports symbol and line validation errors', async () => {
    const missingSymbol = await handleReadForEdit(
      { path: 'file.ts', symbol: 'Missing' },
      tempDir,
      { resolve: async () => null } as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );
    expect(missingSymbol.content[0].text).toContain('Symbol "Missing" not found');

    const badLine = await handleReadForEdit(
      { path: 'file.ts', line: 999 },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );
    expect(badLine.content[0].text).toContain('Line 999 out of range');
  });
});
