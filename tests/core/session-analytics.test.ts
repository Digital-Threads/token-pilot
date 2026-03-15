import { describe, it, expect } from 'vitest';
import { SessionAnalytics } from '../../src/core/session-analytics.js';

describe('SessionAnalytics', () => {
  it('generates empty report with no calls', () => {
    const analytics = new SessionAnalytics();
    const report = analytics.report();
    expect(report).toContain('SESSION ANALYTICS');
    expect(report).toContain('Total tool calls: 0');
  });

  it('records calls and computes savings', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', path: '/a.ts', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });
    analytics.record({ tool: 'smart_read', path: '/b.ts', tokensReturned: 50, tokensWouldBe: 500, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('Total tool calls: 2');
    expect(report).toContain('Tokens returned: ~150');
    expect(report).toContain('90%');
    expect(report).toContain('smart_read: 2 calls');
  });

  it('groups by tool', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 500, timestamp: Date.now() });
    analytics.record({ tool: 'read_symbol', tokensReturned: 20, tokensWouldBe: 20, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('smart_read: 1 calls');
    expect(report).toContain('read_symbol: 1 calls');
  });

  it('shows top files by savings', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', path: '/big.ts', tokensReturned: 100, tokensWouldBe: 5000, timestamp: Date.now() });
    analytics.record({ tool: 'smart_read', path: '/small.ts', tokensReturned: 50, tokensWouldBe: 100, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('/big.ts');
    expect(report).toContain('Top files by savings');
  });

  it('resets state', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });
    analytics.reset();

    const report = analytics.report();
    expect(report).toContain('Total tool calls: 0');
  });

  it('shows context-mode companion info when detected', () => {
    const analytics = new SessionAnalytics();
    analytics.setContextModeStatus({ detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' });
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('Combined Architecture');
    expect(report).toContain('context-mode: active');
    expect(report).toContain('mcp-json');
    expect(report).toContain('/context-mode:stats');
  });

  it('does not show context-mode info when not detected', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).not.toContain('Combined Architecture');
  });

  it('tracks delegation to context-mode', () => {
    const analytics = new SessionAnalytics();
    analytics.setContextModeStatus({ detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' });
    analytics.record({ tool: 'smart_read', path: '/big.json', tokensReturned: 50, tokensWouldBe: 50, timestamp: Date.now(), delegatedToContextMode: true });
    analytics.record({ tool: 'smart_read', path: '/a.ts', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('Delegated to context-mode: 1 calls');
  });

  it('highlights tools with weak savings so they can be improved', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'project_overview', tokensReturned: 90, tokensWouldBe: 100, timestamp: Date.now() });
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('Needs improvement:');
    expect(report).toContain('project_overview: only 10% reduction');
    expect(report).not.toContain('smart_read: only');
  });

  describe('savings categories', () => {
    it('shows savings breakdown by category', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now(), savingsCategory: 'compression' });
      analytics.record({ tool: 'smart_read', tokensReturned: 50, tokensWouldBe: 500, timestamp: Date.now(), savingsCategory: 'cache' });
      analytics.record({ tool: 'read_symbol', tokensReturned: 30, tokensWouldBe: 800, timestamp: Date.now(), savingsCategory: 'dedup' });

      const report = analytics.report();
      expect(report).toContain('Savings breakdown:');
      expect(report).toContain('Compression (AST/structured): ~900 tokens');
      expect(report).toContain('Cache hits (session cache): ~450 tokens');
      expect(report).toContain('Dedup (already in context): ~770 tokens');
    });

    it('shows real tokens saved for session cache hits', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache' });
      analytics.record({ tool: 'read_symbol', tokensReturned: 50, tokensWouldBe: 500, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache' });

      const report = analytics.report();
      expect(report).toContain('Session cache: 2 hits');
      expect(report).toContain('~1350 tokens saved');
      expect(report).not.toContain('tokens served instantly');
    });

    it('shows dedup calls count in compact reminders section', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 30, tokensWouldBe: 800, timestamp: Date.now(), savingsCategory: 'dedup' });
      analytics.record({ tool: 'read_range', tokensReturned: 20, tokensWouldBe: 600, timestamp: Date.now(), savingsCategory: 'dedup' });
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now(), savingsCategory: 'compression' });

      const report = analytics.report();
      expect(report).toContain('Compact reminders/dedup: 2 calls');
    });

    it('omits savings breakdown when no savings', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 100, timestamp: Date.now(), savingsCategory: 'none' });

      const report = analytics.report();
      expect(report).not.toContain('Savings breakdown:');
    });
  });
});
