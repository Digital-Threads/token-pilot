import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadDiff } from '../../src/handlers/read-diff.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadDiff', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-diff-'));
    filePath = join(tempDir, 'file.ts');
    await writeFile(filePath, 'one\ntwo\nthree\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('asks for a baseline when the file was not previously read', async () => {
    const result = await handleReadDiff(
      { path: 'file.ts' },
      tempDir,
      new FileCache(),
      new ContextRegistry(),
    );

    expect(result.content[0].text).toContain('No previous read of "file.ts"');
    expect(result.content[0].text).toContain('Cache is empty');
  });

  it('reports no changes when the hash matches the cached version', async () => {
    const cache = new FileCache();
    const content = 'one\ntwo\nthree\n';
    cache.set(filePath, {
      structure: { path: filePath, language: 'ts', meta: { lines: 3, bytes: 14, lastModified: Date.now(), contentHash: 'hash' }, imports: [], exports: [], symbols: [] },
      content,
      lines: ['one', 'two', 'three', ''],
      mtime: Date.now(),
      hash: createHash('sha256').update(content).digest('hex'),
      lastAccess: Date.now(),
    });
    const result = await handleReadDiff(
      { path: 'file.ts' },
      tempDir,
      cache,
      new ContextRegistry(),
    );

    expect(result.content[0].text).toContain('NO CHANGES: file.ts is unchanged');
  });

  it('shows changed hunks and updates the cached content', async () => {
    const cache = new FileCache();
    const registry = new ContextRegistry();
    registry.trackLoad(filePath, {
      type: 'full',
      startLine: 1,
      endLine: 3,
      tokens: 3,
    });
    registry.setContentHash(filePath, 'ef52b4eafe0e0f44c08f1d5e3af5e30d0b6a57d1dd1c94431df2ea7b29c4fc5f');
    cache.set(filePath, {
      structure: { path: filePath, language: 'ts', meta: { lines: 3, bytes: 14, lastModified: Date.now(), contentHash: 'hash' }, imports: [], exports: [], symbols: [] },
      content: 'one\ntwo\nthree\n',
      lines: ['one', 'two', 'three', ''],
      mtime: Date.now(),
      hash: 'ef52b4eafe0e0f44c08f1d5e3af5e30d0b6a57d1dd1c94431df2ea7b29c4fc5f',
      lastAccess: Date.now(),
    });
    await writeFile(filePath, 'one\ntwo changed\nthree\nfour\n');

    const result = await handleReadDiff(
      { path: 'file.ts', context_lines: 1 },
      tempDir,
      cache,
      registry,
    );

    expect(result.content[0].text).toContain('DIFF: file.ts');
    expect(result.content[0].text).toContain('+');
    expect(result.content[0].text).toContain('-');
    expect(result.content[0].text).toContain('TOKEN SAVINGS:');
    expect(cache.get(filePath)?.content).toContain('two changed');
    expect(registry.isStale(filePath, cache.get(filePath)!.hash)).toBe(false);
  });
});
