import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadRange } from '../../src/handlers/read-range.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadRange', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-range-'));
    await writeFile(join(tempDir, 'file.ts'), 'a\nb\nc\nd\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns formatted numbered lines and tracks the range', async () => {
    const registry = new ContextRegistry();
    const result = await handleReadRange(
      { path: 'file.ts', start_line: 2, end_line: 3 },
      tempDir,
      new FileCache(),
      registry,
    );

    expect(result.content[0].text).toContain('FILE: file.ts [L2-3]');
    expect(result.content[0].text).toContain('   2 | b');
    expect(result.content[0].text).toContain('   3 | c');
    expect(registry.getLoaded(join(tempDir, 'file.ts'))?.[0]?.type).toBe('range');
  });

  describe('dedup', () => {
    it('returns dedup reminder when full file already in context and unchanged', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'a\nb\nc\nd\n',
        lines: ['a', 'b', 'c', 'd', ''],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'full', startLine: 1, endLine: 5, tokens: 20 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadRange(
        { path: 'file.ts', start_line: 2, end_line: 3 },
        tempDir,
        fc,
        registry,
        true,
      );

      expect(result.content[0].text).toContain('DEDUP:');
      expect(result.content[0].text).toContain('[L2-3]');
      expect(result.content[0].text).toContain('full file already in context');
    });

    it('returns fresh content when file has changed (stale hash)', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'a\nb\nc\nd\n',
        lines: ['a', 'b', 'c', 'd', ''],
        mtime: Date.now(),
        hash: 'newhash',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'full', startLine: 1, endLine: 5, tokens: 20 });
      registry.setContentHash(absPath, 'oldhash');

      const result = await handleReadRange(
        { path: 'file.ts', start_line: 2, end_line: 3 },
        tempDir,
        fc,
        registry,
        true,
      );

      expect(result.content[0].text).not.toContain('DEDUP:');
      expect(result.content[0].text).toContain('FILE: file.ts [L2-3]');
    });

    it('returns fresh content when advisoryReminders is false', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'a\nb\nc\nd\n',
        lines: ['a', 'b', 'c', 'd', ''],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'full', startLine: 1, endLine: 5, tokens: 20 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadRange(
        { path: 'file.ts', start_line: 2, end_line: 3 },
        tempDir,
        fc,
        registry,
        false,
      );

      expect(result.content[0].text).not.toContain('DEDUP:');
      expect(result.content[0].text).toContain('FILE: file.ts [L2-3]');
    });

    it('returns fresh content when file only has structure loaded (not full)', async () => {
      const registry = new ContextRegistry();
      const fc = new FileCache();

      const absPath = join(tempDir, 'file.ts');
      fc.set(absPath, {
        structure: { language: 'typescript', imports: [], exports: [], symbols: [] } as any,
        content: 'a\nb\nc\nd\n',
        lines: ['a', 'b', 'c', 'd', ''],
        mtime: Date.now(),
        hash: 'abc123',
        lastAccess: Date.now(),
      });
      registry.trackLoad(absPath, { type: 'structure', startLine: 1, endLine: 5, tokens: 20 });
      registry.setContentHash(absPath, 'abc123');

      const result = await handleReadRange(
        { path: 'file.ts', start_line: 2, end_line: 3 },
        tempDir,
        fc,
        registry,
        true,
      );

      expect(result.content[0].text).not.toContain('DEDUP:');
      expect(result.content[0].text).toContain('FILE: file.ts [L2-3]');
    });
  });

  it('returns an invalid range message when outside file bounds', async () => {
    const result = await handleReadRange(
      { path: 'file.ts', start_line: 10, end_line: 12 },
      tempDir,
      new FileCache(),
      new ContextRegistry(),
    );

    expect(result.content[0].text).toContain('Invalid line range: 10-12');
  });
});
