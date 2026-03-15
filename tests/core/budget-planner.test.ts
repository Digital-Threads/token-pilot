import { describe, it, expect } from 'vitest';
import { suggestCheaperAlternative } from '../../src/core/budget-planner.js';

describe('suggestCheaperAlternative', () => {
  it('suggests read_diff when smart_read on file already in context and recently edited', () => {
    const result = suggestCheaperAlternative('smart_read', { path: 'foo.ts' }, {
      fileLines: 200,
      alreadyInContext: true,
      symbolKnown: false,
      recentlyEdited: true,
    });

    expect(result).not.toBeNull();
    expect(result!.tool).toBe('read_diff');
    expect(result!.reason).toContain('read_diff');
  });

  it('suggests read_symbol when smart_read with known symbol on large file', () => {
    const result = suggestCheaperAlternative('smart_read', { path: 'foo.ts' }, {
      fileLines: 300,
      alreadyInContext: false,
      symbolKnown: true,
      recentlyEdited: false,
    });

    expect(result).not.toBeNull();
    expect(result!.tool).toBe('read_symbol');
    expect(result!.estimatedTokens).toBeLessThan(300);
  });

  it('returns null when smart_read is already optimal', () => {
    const result = suggestCheaperAlternative('smart_read', { path: 'foo.ts' }, {
      fileLines: 30,
      alreadyInContext: false,
      symbolKnown: false,
      recentlyEdited: false,
    });

    expect(result).toBeNull();
  });

  it('suggests read_symbol for large read_range with known symbol', () => {
    const result = suggestCheaperAlternative('read_range', { path: 'foo.ts', limit: 100 }, {
      fileLines: 500,
      alreadyInContext: false,
      symbolKnown: true,
      recentlyEdited: false,
    });

    expect(result).not.toBeNull();
    expect(result!.tool).toBe('read_symbol');
  });

  it('returns null for read_range with small range', () => {
    const result = suggestCheaperAlternative('read_range', { path: 'foo.ts', limit: 20 }, {
      fileLines: 500,
      alreadyInContext: false,
      symbolKnown: true,
      recentlyEdited: false,
    });

    expect(result).toBeNull();
  });

  it('suggests read_diff for read_symbol when symbol already loaded and file edited', () => {
    const result = suggestCheaperAlternative('read_symbol', { path: 'foo.ts', symbol: 'bar' }, {
      fileLines: 200,
      alreadyInContext: true,
      symbolKnown: true,
      recentlyEdited: true,
    });

    expect(result).not.toBeNull();
    expect(result!.tool).toBe('read_diff');
  });

  it('suggests read_diff for smart_read_many when all files in context', () => {
    const result = suggestCheaperAlternative('smart_read_many', { paths: ['a.ts', 'b.ts'] }, {
      fileLines: 400,
      alreadyInContext: true,
      symbolKnown: false,
      recentlyEdited: false,
    });

    expect(result).not.toBeNull();
    expect(result!.tool).toBe('read_diff');
  });

  it('returns null for unknown tools', () => {
    const result = suggestCheaperAlternative('find_usages', { symbol: 'foo' }, {
      alreadyInContext: false,
      symbolKnown: false,
      recentlyEdited: false,
    });

    expect(result).toBeNull();
  });
});
