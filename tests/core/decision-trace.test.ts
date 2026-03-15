import { describe, it, expect } from 'vitest';
import { buildDecisionTrace } from '../../src/core/decision-trace.js';
import { ContextRegistry } from '../../src/core/context-registry.js';
import { FileCache } from '../../src/core/file-cache.js';

describe('buildDecisionTrace', () => {
  it('builds trace with file metadata from cache', () => {
    const fileCache = new FileCache();
    const contextRegistry = new ContextRegistry();
    const absPath = '/project/src/foo.ts';

    fileCache.set(absPath, {
      structure: {
        path: absPath,
        language: 'typescript',
        meta: { lines: 200, bytes: 5000, lastModified: Date.now(), contentHash: 'abc' },
        imports: [],
        exports: [],
        symbols: [],
      },
      content: 'x'.repeat(5000),
      lines: Array.from({ length: 200 }, (_, i) => `line ${i}`),
      mtime: Date.now(),
      hash: 'abc',
      lastAccess: Date.now(),
    });

    const trace = buildDecisionTrace({
      absPath,
      tool: 'smart_read',
      args: { path: 'src/foo.ts' },
      contextRegistry,
      fileCache,
      tokensReturned: 300,
      tokensWouldBe: 1500,
    });

    expect(trace.fileSize).toBe(5000);
    expect(trace.fileTotalLines).toBe(200);
    expect(trace.alreadyInContext).toBe(false);
    expect(trace.estimatedCost).toBe(1500);
    expect(trace.actualCost).toBe(300);
  });

  it('detects alreadyInContext from context registry', () => {
    const fileCache = new FileCache();
    const contextRegistry = new ContextRegistry();
    const absPath = '/project/src/bar.ts';

    contextRegistry.trackLoad(absPath, {
      type: 'structure',
      tokens: 400,
    });

    const trace = buildDecisionTrace({
      absPath,
      tool: 'smart_read',
      args: { path: 'src/bar.ts' },
      contextRegistry,
      fileCache,
      tokensReturned: 400,
      tokensWouldBe: 1000,
    });

    expect(trace.alreadyInContext).toBe(true);
  });

  it('includes budget planner suggestion when applicable', () => {
    const fileCache = new FileCache();
    const contextRegistry = new ContextRegistry();
    const absPath = '/project/src/big.ts';

    // File in context + recently edited → should suggest read_diff
    contextRegistry.trackLoad(absPath, {
      type: 'structure',
      tokens: 800,
    });

    fileCache.set(absPath, {
      structure: {
        path: absPath,
        language: 'typescript',
        meta: { lines: 300, bytes: 8000, lastModified: Date.now(), contentHash: 'xyz' },
        imports: [],
        exports: [],
        symbols: [],
      },
      content: 'x'.repeat(8000),
      lines: Array.from({ length: 300 }, (_, i) => `line ${i}`),
      mtime: Date.now(),
      hash: 'xyz',
      lastAccess: Date.now(),
    });

    const trace = buildDecisionTrace({
      absPath,
      tool: 'smart_read',
      args: { path: 'src/big.ts' },
      contextRegistry,
      fileCache,
      tokensReturned: 800,
      tokensWouldBe: 2000,
      recentlyEdited: true,
    });

    expect(trace.cheaperAlternative).toBe('read_diff');
    expect(trace.cheaperEstimate).toBeDefined();
    expect(trace.cheaperEstimate!).toBeLessThan(trace.actualCost);
  });

  it('returns no suggestion when tool is already optimal', () => {
    const trace = buildDecisionTrace({
      absPath: undefined,
      tool: 'find_usages',
      args: { symbol: 'foo' },
      contextRegistry: new ContextRegistry(),
      fileCache: new FileCache(),
      tokensReturned: 200,
      tokensWouldBe: 500,
    });

    expect(trace.cheaperAlternative).toBeUndefined();
    expect(trace.cheaperEstimate).toBeUndefined();
    expect(trace.alreadyInContext).toBe(false);
  });

  it('handles missing absPath gracefully', () => {
    const trace = buildDecisionTrace({
      absPath: undefined,
      tool: 'session_analytics',
      args: {},
      contextRegistry: new ContextRegistry(),
      fileCache: new FileCache(),
      tokensReturned: 100,
      tokensWouldBe: 100,
    });

    expect(trace.fileSize).toBeUndefined();
    expect(trace.fileTotalLines).toBeUndefined();
    expect(trace.alreadyInContext).toBe(false);
  });
});
