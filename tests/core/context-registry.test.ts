import { describe, it, expect, beforeEach } from 'vitest';
import { ContextRegistry } from '../../src/core/context-registry.js';
import type { SymbolInfo } from '../../src/types.js';

function makeSymbol(name: string, startLine: number, endLine: number): SymbolInfo {
  return {
    name,
    qualifiedName: name,
    kind: 'function',
    signature: `function ${name}()`,
    location: { startLine, endLine, lineCount: endLine - startLine + 1 },
    visibility: 'public',
    async: false,
    static: false,
    decorators: [],
    children: [],
    doc: null,
    references: [],
  };
}

describe('ContextRegistry', () => {
  let registry: ContextRegistry;

  beforeEach(() => {
    registry = new ContextRegistry();
  });

  it('tracks a load and returns loaded regions', () => {
    registry.trackLoad('/foo.ts', {
      type: 'structure',
      startLine: 1,
      endLine: 100,
      tokens: 50,
    });

    const loaded = registry.getLoaded('/foo.ts');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(1);
    expect(loaded![0].type).toBe('structure');
    expect(loaded![0].tokens).toBe(50);
  });

  it('returns null for untracked files', () => {
    expect(registry.getLoaded('/missing.ts')).toBeNull();
  });

  it('replaces region of same type/symbol', () => {
    registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 100, tokens: 50 });
    registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 200, tokens: 80 });

    const loaded = registry.getLoaded('/foo.ts')!;
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tokens).toBe(80);
  });

  it('adds different region types', () => {
    registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 100, tokens: 50 });
    registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'doStuff', startLine: 10, endLine: 20, tokens: 15 });

    expect(registry.getLoaded('/foo.ts')).toHaveLength(2);
  });

  it('checks if symbol is loaded', () => {
    registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'myFunc', startLine: 1, endLine: 10, tokens: 20 });

    expect(registry.isSymbolLoaded('/foo.ts', 'myFunc')).toBe(true);
    expect(registry.isSymbolLoaded('/foo.ts', 'other')).toBe(false);
    expect(registry.isSymbolLoaded('/bar.ts', 'myFunc')).toBe(false);
  });

  it('detects stale content via hash', () => {
    registry.trackLoad('/foo.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 20 });
    registry.setContentHash('/foo.ts', 'hash1');

    expect(registry.isStale('/foo.ts', 'hash1')).toBe(false);
    expect(registry.isStale('/foo.ts', 'hash2')).toBe(true);
    expect(registry.isStale('/untracked.ts', 'hash1')).toBe(true);
  });

  it('generates compact reminder', () => {
    registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 100, tokens: 50 });
    const symbols = [
      makeSymbol('doA', 1, 10),
      makeSymbol('doB', 11, 20),
    ];

    const reminder = registry.compactReminder('/foo.ts', symbols);
    expect(reminder).toContain('REMINDER:');
    expect(reminder).toContain('/foo.ts');
    expect(reminder).toContain('doA');
    expect(reminder).toContain('doB');
    expect(reminder).toContain('HINT:');
  });

  it('compact reminder shows symbol count when > 5', () => {
    registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 100, tokens: 50 });
    const symbols = Array.from({ length: 8 }, (_, i) => makeSymbol(`fn${i}`, i * 10, i * 10 + 9));

    const reminder = registry.compactReminder('/foo.ts', symbols);
    expect(reminder).toContain('3 more symbols');
  });

  it('forgets a specific file', () => {
    registry.trackLoad('/a.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 20 });
    registry.trackLoad('/b.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 20 });

    registry.forget('/a.ts');
    expect(registry.getLoaded('/a.ts')).toBeNull();
    expect(registry.getLoaded('/b.ts')).not.toBeNull();
  });

  it('forgets a specific symbol from a file', () => {
    registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'fnA', startLine: 1, endLine: 10, tokens: 10 });
    registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'fnB', startLine: 11, endLine: 20, tokens: 15 });

    registry.forget('/foo.ts', 'fnA');
    const loaded = registry.getLoaded('/foo.ts')!;
    expect(loaded).toHaveLength(1);
    expect(loaded[0].symbolName).toBe('fnB');
  });

  it('removes file entry when last symbol is forgotten', () => {
    registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'fnA', startLine: 1, endLine: 10, tokens: 10 });
    registry.forget('/foo.ts', 'fnA');
    expect(registry.getLoaded('/foo.ts')).toBeNull();
  });

  it('forgets all', () => {
    registry.trackLoad('/a.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 20 });
    registry.trackLoad('/b.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 20 });
    registry.forgetAll();

    expect(registry.getLoaded('/a.ts')).toBeNull();
    expect(registry.getLoaded('/b.ts')).toBeNull();
    expect(registry.summary().files).toBe(0);
  });

  it('provides summary with totals', () => {
    registry.trackLoad('/a.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 50 });
    registry.trackLoad('/b.ts', { type: 'structure', startLine: 1, endLine: 20, tokens: 30 });

    const summary = registry.summary();
    expect(summary.files).toBe(2);
    expect(summary.totalTokens).toBe(80);
    expect(summary.entries).toHaveLength(2);
    expect(summary.sessionDuration).toBeGreaterThanOrEqual(0);
  });

  it('estimateTokens sums all entries', () => {
    registry.trackLoad('/a.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 100 });
    registry.trackLoad('/b.ts', { type: 'structure', startLine: 1, endLine: 20, tokens: 200 });
    expect(registry.estimateTokens()).toBe(300);
  });

  describe('isFullyLoaded', () => {
    it('returns true when type=full region exists', () => {
      registry.trackLoad('/foo.ts', { type: 'full', startLine: 1, endLine: 100, tokens: 200 });
      expect(registry.isFullyLoaded('/foo.ts')).toBe(true);
    });

    it('returns false when only structure/symbol regions exist', () => {
      registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 100, tokens: 50 });
      registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'fn', startLine: 10, endLine: 20, tokens: 15 });
      expect(registry.isFullyLoaded('/foo.ts')).toBe(false);
    });

    it('returns false for untracked file', () => {
      expect(registry.isFullyLoaded('/missing.ts')).toBe(false);
    });
  });

  describe('symbolReminder', () => {
    it('returns reminder when full file loaded', () => {
      registry.trackLoad('/foo.ts', { type: 'full', startLine: 1, endLine: 100, tokens: 200 });
      const reminder = registry.symbolReminder('/foo.ts', 'myFunc');
      expect(reminder).toContain('DEDUP:');
      expect(reminder).toContain('"myFunc"');
      expect(reminder).toContain('full file already in context');
      expect(reminder).toContain('200 tokens');
      expect(reminder).toContain('HINT:');
    });

    it('includes symbol location when symbol region also exists', () => {
      registry.trackLoad('/foo.ts', { type: 'full', startLine: 1, endLine: 100, tokens: 200 });
      registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'myFunc', startLine: 10, endLine: 30, tokens: 40 });
      const reminder = registry.symbolReminder('/foo.ts', 'myFunc');
      expect(reminder).toContain('Symbol at [L10-30]');
    });

    it('returns reminder when same symbol loaded (no full file)', () => {
      registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'myFunc', startLine: 10, endLine: 30, tokens: 40 });
      const reminder = registry.symbolReminder('/foo.ts', 'myFunc');
      expect(reminder).toContain('DEDUP:');
      expect(reminder).toContain('"myFunc"');
      expect(reminder).toContain('[L10-30]');
      expect(reminder).toContain('40 tokens');
      expect(reminder).toContain('unchanged');
    });

    it('returns empty string when symbol not loaded', () => {
      registry.trackLoad('/foo.ts', { type: 'symbol', symbolName: 'other', startLine: 10, endLine: 30, tokens: 40 });
      expect(registry.symbolReminder('/foo.ts', 'myFunc')).toBe('');
    });

    it('returns empty string for untracked file', () => {
      expect(registry.symbolReminder('/missing.ts', 'myFunc')).toBe('');
    });
  });

  describe('rangeReminder', () => {
    it('returns reminder when full file loaded', () => {
      registry.trackLoad('/foo.ts', { type: 'full', startLine: 1, endLine: 100, tokens: 200 });
      const reminder = registry.rangeReminder('/foo.ts', 10, 30);
      expect(reminder).toContain('DEDUP:');
      expect(reminder).toContain('[L10-30]');
      expect(reminder).toContain('full file already in context');
      expect(reminder).toContain('200 tokens');
      expect(reminder).toContain('HINT:');
    });

    it('returns empty string when file not fully loaded', () => {
      registry.trackLoad('/foo.ts', { type: 'structure', startLine: 1, endLine: 100, tokens: 50 });
      expect(registry.rangeReminder('/foo.ts', 10, 30)).toBe('');
    });

    it('returns empty string for untracked file', () => {
      expect(registry.rangeReminder('/missing.ts', 10, 30)).toBe('');
    });
  });

  it('invalidates by git diff', () => {
    registry.trackLoad('/a.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 10 });
    registry.trackLoad('/b.ts', { type: 'full', startLine: 1, endLine: 10, tokens: 10 });

    registry.invalidateByGitDiff(['/a.ts']);
    expect(registry.getLoaded('/a.ts')).toBeNull();
    expect(registry.getLoaded('/b.ts')).not.toBeNull();
  });
});
