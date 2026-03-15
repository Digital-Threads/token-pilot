import { describe, it, expect } from 'vitest';
import { assessConfidence, formatConfidence } from '../../src/core/confidence.js';

describe('assessConfidence', () => {
  it('returns high when symbol resolved with full context', () => {
    const result = assessConfidence({
      symbolResolved: true,
      fullFile: true,
      truncated: false,
      hasTests: true,
      hasCallers: true,
      astAvailable: true,
    });

    expect(result.confidence).toBe('high');
    expect(result.knownUnknowns).toHaveLength(0);
    expect(result.suggestedNextStep).toBeUndefined();
  });

  it('returns medium when symbol resolved but truncated', () => {
    const result = assessConfidence({
      symbolResolved: true,
      truncated: true,
      astAvailable: true,
    });

    expect(result.confidence).toBe('medium');
    expect(result.knownUnknowns).toContain('output was truncated — some content not shown');
    expect(result.suggestedNextStep).toContain('read_range');
  });

  it('returns low when symbol not resolved and no AST', () => {
    const result = assessConfidence({
      symbolResolved: false,
      astAvailable: false,
    });

    expect(result.confidence).toBe('low');
    expect(result.knownUnknowns).toContain('target symbol not resolved');
    expect(result.knownUnknowns).toContain('AST index unavailable — structural analysis limited');
  });

  it('flags cross-file dependencies', () => {
    const result = assessConfidence({
      symbolResolved: true,
      crossFileDeps: 8,
      astAvailable: true,
    });

    expect(result.knownUnknowns.some(u => u.includes('8 cross-file dependencies'))).toBe(true);
  });

  it('flags missing tests', () => {
    const result = assessConfidence({
      symbolResolved: true,
      hasTests: false,
    });

    expect(result.knownUnknowns).toContain('no test file found for this module');
  });

  it('boosts score for dedup hit', () => {
    const withDedup = assessConfidence({
      symbolResolved: true,
      dedupHit: true,
      astAvailable: true,
    });

    const withoutDedup = assessConfidence({
      symbolResolved: true,
      dedupHit: false,
      astAvailable: true,
    });

    // dedup hit adds +1, so confidence can only be same or higher
    expect(['high', 'medium'].includes(withDedup.confidence)).toBe(true);
    expect(withDedup.knownUnknowns.length).toBeLessThanOrEqual(withoutDedup.knownUnknowns.length);
  });

  it('suggests smart_read when symbol not resolved', () => {
    const result = assessConfidence({
      symbolResolved: false,
    });

    expect(result.suggestedNextStep).toContain('smart_read');
  });

  it('suggests read_range when AST unavailable', () => {
    const result = assessConfidence({
      astAvailable: false,
    });

    expect(result.suggestedNextStep).toContain('read_range');
  });
});

describe('formatConfidence', () => {
  it('formats high confidence with no unknowns', () => {
    const output = formatConfidence({
      confidence: 'high',
      knownUnknowns: [],
    });

    expect(output).toContain('CONFIDENCE: high');
    expect(output).toContain('KNOWN UNKNOWNS: none');
    expect(output).not.toContain('SUGGESTED:');
  });

  it('formats medium confidence with unknowns and suggestion', () => {
    const output = formatConfidence({
      confidence: 'medium',
      knownUnknowns: ['output was truncated'],
      suggestedNextStep: 'use read_range() for full content',
    });

    expect(output).toContain('CONFIDENCE: medium');
    expect(output).toContain('KNOWN UNKNOWNS: output was truncated');
    expect(output).toContain('SUGGESTED: use read_range()');
  });

  it('joins multiple unknowns with semicolons', () => {
    const output = formatConfidence({
      confidence: 'low',
      knownUnknowns: ['symbol not resolved', 'AST unavailable'],
    });

    expect(output).toContain('symbol not resolved; AST unavailable');
  });
});
