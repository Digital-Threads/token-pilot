import { describe, expect, it } from 'vitest';
import { SessionCache } from '../../src/core/session-cache.js';

const makeResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

describe('SessionCache', () => {
  describe('basic get/set', () => {
    it('returns null for cache miss', () => {
      const cache = new SessionCache(100);
      expect(cache.get('outline', { path: 'src/' })).toBeNull();
      expect(cache.stats().misses).toBe(1);
    });

    it('stores and retrieves entries by tool+args', () => {
      const cache = new SessionCache(100);
      const result = makeResult('outline content');
      cache.set('outline', { path: 'src/' }, result, { dependsOnAst: true }, 50);

      const cached = cache.get('outline', { path: 'src/' });
      expect(cached).not.toBeNull();
      expect(cached!.result.content[0].text).toBe('outline content');
      expect(cached!.tokenEstimate).toBe(50);
      expect(cached!.dependsOnAst).toBe(true);
      expect(cache.stats().hits).toBe(1);
    });

    it('cache key is deterministic regardless of arg key order', () => {
      const cache = new SessionCache(100);
      const result = makeResult('data');
      cache.set('find_usages', { symbol: 'foo', scope: 'src' }, result, {}, 10);

      // Same args, different key order
      const cached = cache.get('find_usages', { scope: 'src', symbol: 'foo' });
      expect(cached).not.toBeNull();
      expect(cached!.result.content[0].text).toBe('data');
    });

    it('different args produce different keys', () => {
      const cache = new SessionCache(100);
      cache.set('outline', { path: 'src/' }, makeResult('src'), {}, 10);
      cache.set('outline', { path: 'tests/' }, makeResult('tests'), {}, 20);

      expect(cache.get('outline', { path: 'src/' })!.result.content[0].text).toBe('src');
      expect(cache.get('outline', { path: 'tests/' })!.result.content[0].text).toBe('tests');
      expect(cache.stats().entries).toBe(2);
    });

    it('evicts oldest entry when maxEntries exceeded', () => {
      const cache = new SessionCache(2);
      cache.set('a', { x: 1 }, makeResult('first'), {}, 10);
      // Ensure different cachedAt
      cache.set('b', { x: 2 }, makeResult('second'), {}, 20);
      cache.set('c', { x: 3 }, makeResult('third'), {}, 30);

      // 'first' should have been evicted (oldest)
      expect(cache.get('a', { x: 1 })).toBeNull();
      expect(cache.get('b', { x: 2 })).not.toBeNull();
      expect(cache.get('c', { x: 3 })).not.toBeNull();
      expect(cache.stats().entries).toBe(2);
    });
  });

  describe('invalidateByFiles', () => {
    it('invalidates entries with matching exact file deps', () => {
      const cache = new SessionCache(100);
      cache.set('find_usages', { symbol: 'A' }, makeResult('a'), {
        files: ['/project/src/a.ts'],
        dependsOnAst: true,
      }, 10);
      cache.set('find_usages', { symbol: 'B' }, makeResult('b'), {
        files: ['/project/src/b.ts'],
        dependsOnAst: true,
      }, 10);

      const count = cache.invalidateByFiles(['/project/src/a.ts']);
      expect(count).toBe(1);
      expect(cache.get('find_usages', { symbol: 'A' })).toBeNull();
      expect(cache.get('find_usages', { symbol: 'B' })).not.toBeNull();
    });

    it('invalidates entries with directory prefix deps', () => {
      const cache = new SessionCache(100);
      cache.set('outline', { path: 'src/handlers' }, makeResult('handlers'), {
        files: ['/project/src/handlers/'],
      }, 10);
      cache.set('outline', { path: 'src/core' }, makeResult('core'), {
        files: ['/project/src/core/'],
      }, 10);

      // File change inside /project/src/handlers/ should invalidate that outline
      const count = cache.invalidateByFiles(['/project/src/handlers/smart-read.ts']);
      expect(count).toBe(1);
      expect(cache.get('outline', { path: 'src/handlers' })).toBeNull();
      expect(cache.get('outline', { path: 'src/core' })).not.toBeNull();
    });

    it('does not invalidate entries without matching file deps', () => {
      const cache = new SessionCache(100);
      cache.set('project_overview', {}, makeResult('overview'), { dependsOnAst: true }, 10);

      const count = cache.invalidateByFiles(['/project/src/foo.ts']);
      expect(count).toBe(0);
      expect(cache.get('project_overview', {})).not.toBeNull();
    });

    it('handles multiple file changes in single call', () => {
      const cache = new SessionCache(100);
      cache.set('a', {}, makeResult('a'), { files: ['/f1.ts'] }, 10);
      cache.set('b', {}, makeResult('b'), { files: ['/f2.ts'] }, 10);
      cache.set('c', {}, makeResult('c'), { files: ['/f3.ts'] }, 10);

      const count = cache.invalidateByFiles(['/f1.ts', '/f2.ts']);
      expect(count).toBe(2);
      expect(cache.stats().entries).toBe(1);
    });
  });

  describe('invalidateByAst', () => {
    it('invalidates all entries with dependsOnAst=true', () => {
      const cache = new SessionCache(100);
      cache.set('find_usages', { s: 'x' }, makeResult('usages'), { dependsOnAst: true }, 10);
      cache.set('outline', { p: 'y' }, makeResult('outline'), { dependsOnAst: true }, 20);
      cache.set('explore_area', { p: 'z' }, makeResult('area'), { dependsOnAst: true, dependsOnGit: true }, 30);

      const count = cache.invalidateByAst();
      expect(count).toBe(3);
      expect(cache.stats().entries).toBe(0);
    });

    it('preserves entries with dependsOnAst=false', () => {
      const cache = new SessionCache(100);
      cache.set('custom', { x: 1 }, makeResult('no-ast'), {}, 10);
      cache.set('ast_tool', { x: 2 }, makeResult('ast'), { dependsOnAst: true }, 20);

      cache.invalidateByAst();
      expect(cache.get('custom', { x: 1 })).not.toBeNull();
      expect(cache.get('ast_tool', { x: 2 })).toBeNull();
    });
  });

  describe('invalidateByGit', () => {
    it('invalidates all entries with dependsOnGit=true', () => {
      const cache = new SessionCache(100);
      cache.set('explore_area', { p: 'src' }, makeResult('area'), { dependsOnGit: true }, 10);
      cache.set('outline', { p: 'src' }, makeResult('outline'), { dependsOnAst: true }, 20);

      const count = cache.invalidateByGit();
      expect(count).toBe(1);
      expect(cache.get('explore_area', { p: 'src' })).toBeNull();
      expect(cache.get('outline', { p: 'src' })).not.toBeNull();
    });
  });

  describe('invalidateAll', () => {
    it('clears all entries', () => {
      const cache = new SessionCache(100);
      cache.set('a', {}, makeResult('a'), {}, 10);
      cache.set('b', {}, makeResult('b'), {}, 20);
      cache.set('c', {}, makeResult('c'), {}, 30);

      cache.invalidateAll();
      expect(cache.stats().entries).toBe(0);
      expect(cache.stats().invalidations).toBe(3);
    });
  });

  describe('stats', () => {
    it('tracks hits and misses', () => {
      const cache = new SessionCache(100);
      cache.set('outline', { p: 'x' }, makeResult('x'), {}, 10);

      cache.get('outline', { p: 'x' }); // hit
      cache.get('outline', { p: 'y' }); // miss
      cache.get('outline', { p: 'x' }); // hit

      const stats = cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(67); // 2/3 = 67%
    });

    it('tracks invalidation count', () => {
      const cache = new SessionCache(100);
      cache.set('a', {}, makeResult('a'), { files: ['/f.ts'] }, 10);
      cache.set('b', {}, makeResult('b'), { dependsOnAst: true }, 10);

      cache.invalidateByFiles(['/f.ts']);
      cache.invalidateByAst();

      expect(cache.stats().invalidations).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles empty args object', () => {
      const cache = new SessionCache(100);
      cache.set('project_overview', {}, makeResult('overview'), {}, 10);
      expect(cache.get('project_overview', {})).not.toBeNull();
    });

    it('handles set with no file deps', () => {
      const cache = new SessionCache(100);
      cache.set('code_audit', { check: 'todo' }, makeResult('todos'), { dependsOnAst: true }, 10);
      expect(cache.get('code_audit', { check: 'todo' })).not.toBeNull();
      // File invalidation should not affect it
      cache.invalidateByFiles(['/some/file.ts']);
      expect(cache.get('code_audit', { check: 'todo' })).not.toBeNull();
    });

    it('handles invalidateByFiles with empty array', () => {
      const cache = new SessionCache(100);
      cache.set('a', {}, makeResult('a'), {}, 10);
      const count = cache.invalidateByFiles([]);
      expect(count).toBe(0);
      expect(cache.stats().entries).toBe(1);
    });

    it('cleans up reverse index when entries are deleted', () => {
      const cache = new SessionCache(100);
      cache.set('a', {}, makeResult('a'), { files: ['/f.ts'] }, 10);
      cache.invalidateByFiles(['/f.ts']);
      // Set again with same dep — should not have stale index
      cache.set('b', {}, makeResult('b'), { files: ['/f.ts'] }, 20);
      const count = cache.invalidateByFiles(['/f.ts']);
      expect(count).toBe(1);
    });
  });

  describe('tokensWouldBe', () => {
    it('stores tokensWouldBe when provided', () => {
      const cache = new SessionCache(100);
      cache.set('smart_read', { path: 'a.ts' }, makeResult('data'), {}, 50, 500);

      const cached = cache.get('smart_read', { path: 'a.ts' });
      expect(cached).not.toBeNull();
      expect(cached!.tokenEstimate).toBe(50);
      expect(cached!.tokensWouldBe).toBe(500);
    });

    it('tokensWouldBe is undefined when not provided', () => {
      const cache = new SessionCache(100);
      cache.set('smart_read', { path: 'b.ts' }, makeResult('data'), {}, 50);

      const cached = cache.get('smart_read', { path: 'b.ts' });
      expect(cached).not.toBeNull();
      expect(cached!.tokensWouldBe).toBeUndefined();
    });
  });
});
