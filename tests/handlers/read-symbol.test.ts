import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadSymbol } from '../../src/handlers/read-symbol.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadSymbol', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-symbol-'));
    filePath = join(tempDir, 'file.ts');
    await writeFile(filePath, Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a hint when the symbol cannot be resolved', async () => {
    const result = await handleReadSymbol(
      { path: 'file.ts', symbol: 'Missing' },
      tempDir,
      { resolve: async () => null, extractSource: () => '' } as any,
      new FileCache(),
      new ContextRegistry(),
    );

    expect(result.content[0].text).toContain('Symbol "Missing" not found');
    expect(result.content[0].text).toContain('Use smart_read("file.ts")');
  });

  it('renders head, tail, and references for a resolved symbol', async () => {
    const resolved = {
      symbol: {
        kind: 'function',
        children: [],
        references: ['src/a.ts:1', 'src/b.ts:2'],
      },
      startLine: 10,
      endLine: 80,
    };
    const source = Array.from({ length: 71 }, (_, i) => `body ${i + 1}`).join('\n');
    const symbolResolver = {
      resolve: async () => resolved,
      extractSource: () => source,
    } as any;

    const head = await handleReadSymbol(
      { path: 'file.ts', symbol: 'Thing', show: 'head' },
      tempDir,
      symbolResolver,
      new FileCache(),
      new ContextRegistry(),
    );
    expect(head.content[0].text).toContain('show=head');
    expect(head.content[0].text).toContain('... 21 more lines');
    expect(head.content[0].text).toContain('REFERENCES: src/a.ts:1, src/b.ts:2');

    const tail = await handleReadSymbol(
      { path: 'file.ts', symbol: 'Thing', show: 'tail' },
      tempDir,
      symbolResolver,
      new FileCache(),
      new ContextRegistry(),
    );
    expect(tail.content[0].text).toContain('... 41 lines above ...');
  });

  describe('dedup', () => {
    it('returns dedup reminder when full file already in context and unchanged', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      // Simulate: file cached with hash, full file loaded in context
      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'line 1\nline 2',
        lines: ['line 1', 'line 2'],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'full', startLine: 1, endLine: 2, tokens: 50 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadSymbol(
        { path: 'file.ts', symbol: 'MyFunc' },
        tempDir,
        { resolve: async () => null, extractSource: () => '' } as any,
        fc,
        registry,
        undefined,
        true, // advisoryReminders
      );

      expect(result.content[0].text).toContain('DEDUP:');
      expect(result.content[0].text).toContain('full file already in context');
    });

    it('returns dedup reminder when same symbol already loaded and unchanged', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'line 1\nline 2',
        lines: ['line 1', 'line 2'],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'symbol', symbolName: 'MyFunc', startLine: 10, endLine: 30, tokens: 80 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadSymbol(
        { path: 'file.ts', symbol: 'MyFunc' },
        tempDir,
        { resolve: async () => null, extractSource: () => '' } as any,
        fc,
        registry,
        undefined,
        true,
      );

      expect(result.content[0].text).toContain('DEDUP:');
      expect(result.content[0].text).toContain('"MyFunc"');
      expect(result.content[0].text).toContain('[L10-30]');
    });

    it('returns fresh content when file has changed (stale hash)', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'line 1\nline 2',
        lines: ['line 1', 'line 2'],
        mtime: Date.now(),
        hash: 'newhash',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'full', startLine: 1, endLine: 2, tokens: 50 });
      registry.setContentHash(absPath, 'oldhash'); // Different from cached hash

      const result = await handleReadSymbol(
        { path: 'file.ts', symbol: 'Missing' },
        tempDir,
        { resolve: async () => null, extractSource: () => '' } as any,
        fc,
        registry,
        undefined,
        true,
      );

      // Should NOT be dedup — file changed
      expect(result.content[0].text).not.toContain('DEDUP:');
      expect(result.content[0].text).toContain('Symbol "Missing" not found');
    });

    it('returns fresh content when advisoryReminders is false', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'line 1\nline 2',
        lines: ['line 1', 'line 2'],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'full', startLine: 1, endLine: 2, tokens: 50 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadSymbol(
        { path: 'file.ts', symbol: 'Missing' },
        tempDir,
        { resolve: async () => null, extractSource: () => '' } as any,
        fc,
        registry,
        undefined,
        false, // advisoryReminders disabled
      );

      expect(result.content[0].text).not.toContain('DEDUP:');
    });

    it('returns fresh content for symbol not previously loaded', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'line 1\nline 2',
        lines: ['line 1', 'line 2'],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      // Only 'otherSymbol' is loaded, not 'MyFunc'
      registry.trackLoad(absPath, { type: 'symbol', symbolName: 'otherSymbol', startLine: 5, endLine: 15, tokens: 30 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadSymbol(
        { path: 'file.ts', symbol: 'MyFunc' },
        tempDir,
        { resolve: async () => null, extractSource: () => '' } as any,
        fc,
        registry,
        undefined,
        true,
      );

      // Should NOT be dedup — different symbol
      expect(result.content[0].text).not.toContain('DEDUP:');
    });
  });

  it('renders outline mode with child methods and tracks the symbol', async () => {
    const registry = new ContextRegistry();
    const resolved = {
      symbol: {
        kind: 'class',
        children: [
          {
            name: 'alpha',
            kind: 'method',
            visibility: 'public',
            location: { startLine: 20, endLine: 25, lineCount: 6 },
          },
          {
            name: 'beta',
            kind: 'method',
            visibility: 'private',
            location: { startLine: 30, endLine: 35, lineCount: 6 },
          },
        ],
        references: [],
      },
      startLine: 1,
      endLine: 400,
    };
    const source = Array.from({ length: 400 }, (_, i) => `body ${i + 1}`).join('\n');
    const result = await handleReadSymbol(
      { path: 'file.ts', symbol: 'BigClass' },
      tempDir,
      {
        resolve: async () => resolved,
        extractSource: () => source,
      } as any,
      new FileCache(),
      registry,
    );

    expect(result.content[0].text).toContain('show=outline');
    expect(result.content[0].text).toContain('METHODS (2):');
    expect(result.content[0].text).toContain('alpha() [L20-25]');
    expect(result.content[0].text).toContain('🔒 beta() [L30-35]');
    expect(registry.isSymbolLoaded(filePath, 'BigClass')).toBe(true);
  });
});
