import { describe, it, expect, beforeEach } from 'vitest';
import { FileCache } from '../../src/core/file-cache.js';
import type { CacheEntry, FileStructure } from '../../src/types.js';

function makeCacheEntry(path: string, content: string): CacheEntry {
  return {
    structure: {
      path,
      language: 'TypeScript',
      meta: { lines: content.split('\n').length, bytes: content.length, lastModified: Date.now(), contentHash: 'abc' },
      imports: [],
      exports: [],
      symbols: [],
    },
    content,
    lines: content.split('\n'),
    mtime: Date.now(),
    hash: 'abc123',
    lastAccess: Date.now(),
  };
}

describe('FileCache', () => {
  let cache: FileCache;

  beforeEach(() => {
    cache = new FileCache(1, 80); // 1MB max, 80-line threshold
  });

  it('returns null for missing entries', () => {
    expect(cache.get('/missing')).toBeNull();
  });

  it('stores and retrieves entries', () => {
    const entry = makeCacheEntry('/foo.ts', 'const x = 1;');
    cache.set('/foo.ts', entry);
    const result = cache.get('/foo.ts');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('const x = 1;');
  });

  it('tracks hit/miss stats', () => {
    cache.get('/miss1');
    cache.get('/miss2');
    const entry = makeCacheEntry('/hit.ts', 'x');
    cache.set('/hit.ts', entry);
    cache.get('/hit.ts');

    const stats = cache.stats();
    expect(stats.hitRate).toBeCloseTo(1 / 3);
    expect(stats.entries).toBe(1);
  });

  it('invalidates specific file', () => {
    const entry = makeCacheEntry('/foo.ts', 'content');
    cache.set('/foo.ts', entry);
    expect(cache.get('/foo.ts')).not.toBeNull();

    cache.invalidate('/foo.ts');
    expect(cache.get('/foo.ts')).toBeNull();
  });

  it('invalidates all files', () => {
    cache.set('/a.ts', makeCacheEntry('/a.ts', 'a'));
    cache.set('/b.ts', makeCacheEntry('/b.ts', 'b'));
    cache.invalidate();
    expect(cache.get('/a.ts')).toBeNull();
    expect(cache.get('/b.ts')).toBeNull();
    expect(cache.stats().entries).toBe(0);
  });

  it('evicts LRU when max size exceeded', () => {
    // Max = 1MB = 1048576 bytes
    const bigContent = 'x'.repeat(600_000);
    cache.set('/old.ts', makeCacheEntry('/old.ts', bigContent));
    cache.set('/new.ts', makeCacheEntry('/new.ts', bigContent));

    // old should have been evicted to make room
    expect(cache.get('/old.ts')).toBeNull();
    expect(cache.get('/new.ts')).not.toBeNull();
  });

  it('invalidates by git diff file list', async () => {
    cache.set('/a.ts', makeCacheEntry('/a.ts', 'a'));
    cache.set('/b.ts', makeCacheEntry('/b.ts', 'b'));
    cache.set('/c.ts', makeCacheEntry('/c.ts', 'c'));

    await cache.invalidateByGitDiff(['/a.ts', '/c.ts']);
    expect(cache.get('/a.ts')).toBeNull();
    expect(cache.get('/b.ts')).not.toBeNull();
    expect(cache.get('/c.ts')).toBeNull();
  });

  it('reports correct size after invalidation', () => {
    cache.set('/a.ts', makeCacheEntry('/a.ts', 'hello'));
    const sizeBefore = cache.stats().sizeBytes;
    expect(sizeBefore).toBe(5);

    cache.invalidate('/a.ts');
    expect(cache.stats().sizeBytes).toBe(0);
  });

  it('returns smallFileThreshold', () => {
    expect(cache.getSmallFileThreshold()).toBe(80);
  });
});
