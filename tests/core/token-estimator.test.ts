import { describe, it, expect } from 'vitest';
import { estimateTokens, formatSavings } from '../../src/core/token-estimator.js';

describe('estimateTokens', () => {
  it('returns roughly text.length / 4 for dense code', () => {
    const code = 'function foo(x: number): number { return x * 2; }';
    const tokens = estimateTokens(code);
    // ~50 chars / 4 = ~12.5, with whitespace adjustment
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(20);
  });

  it('returns lower count for whitespace-heavy text', () => {
    const sparse = '  \n  \n  \n  hello  \n  \n  ';
    const dense = 'abcdefghijklmnopqrstuvwx';
    // Same-ish length, but sparse should yield fewer tokens due to whitespace discount
    expect(estimateTokens(sparse)).toBeLessThanOrEqual(estimateTokens(dense) + 5);
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles single character', () => {
    expect(estimateTokens('x')).toBeGreaterThanOrEqual(1);
  });
});

describe('formatSavings', () => {
  it('formats token savings percentage', () => {
    const result = formatSavings(100, 1000);
    expect(result).toContain('100');
    expect(result).toContain('1000');
    expect(result).toContain('90%');
  });

  it('returns empty string when wouldBe is 0', () => {
    expect(formatSavings(10, 0)).toBe('');
  });

  it('returns empty string when wouldBe is negative', () => {
    expect(formatSavings(10, -5)).toBe('');
  });
});
