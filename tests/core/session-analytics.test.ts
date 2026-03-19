import { describe, it, expect } from 'vitest';
import { SessionAnalytics } from '../../src/core/session-analytics.js';

describe('SessionAnalytics', () => {
  it('generates empty report with no calls', () => {
    const analytics = new SessionAnalytics();
    const report = analytics.report();
    expect(report).toContain('SESSION ANALYTICS');
    expect(report).toContain('Calls: 0');
  });

  it('records calls and computes savings', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', path: '/a.ts', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });
    analytics.record({ tool: 'smart_read', path: '/b.ts', tokensReturned: 50, tokensWouldBe: 500, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('Calls: 2');
    expect(report).toContain('Tokens returned: ~150');
    expect(report).toContain('90%');
    expect(report).toContain('smart_read 2×');
  });

  it('groups by tool', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 500, timestamp: Date.now() });
    analytics.record({ tool: 'read_symbol', tokensReturned: 20, tokensWouldBe: 20, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('smart_read 1×');
    expect(report).toContain('read_symbol 1×');
  });

  it('shows top files by savings', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', path: '/big.ts', tokensReturned: 100, tokensWouldBe: 5000, timestamp: Date.now() });
    analytics.record({ tool: 'smart_read', path: '/small.ts', tokensReturned: 50, tokensWouldBe: 100, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('/big.ts');
    expect(report).toContain('Top files:');
  });

  it('resets state', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });
    analytics.reset();

    const report = analytics.report();
    expect(report).toContain('Calls: 0');
  });

  it('shows context-mode status when detected', () => {
    const analytics = new SessionAnalytics();
    analytics.setContextModeStatus({ detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' });
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('context-mode: active');
    expect(report).toContain('mcp-json');
  });

  it('does not show context-mode info when not detected', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).not.toContain('context-mode: active');
  });

  it('tracks delegation to context-mode without breaking report', () => {
    const analytics = new SessionAnalytics();
    analytics.setContextModeStatus({ detected: true, source: 'mcp-json', toolPrefix: 'mcp__cm__' });
    analytics.record({ tool: 'smart_read', path: '/big.json', tokensReturned: 50, tokensWouldBe: 50, timestamp: Date.now(), delegatedToContextMode: true });
    analytics.record({ tool: 'smart_read', path: '/a.ts', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('Calls: 2');
    expect(report).toContain('context-mode: active');
  });

  it('shows per-tool savings percentage', () => {
    const analytics = new SessionAnalytics();
    analytics.record({ tool: 'project_overview', tokensReturned: 90, tokensWouldBe: 100, timestamp: Date.now() });
    analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now() });

    const report = analytics.report();
    expect(report).toContain('smart_read 1×');
    expect(report).toContain('project_overview 1×');
  });

  describe('savings categories', () => {
    it('shows overall savings regardless of category', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now(), savingsCategory: 'compression' });
      analytics.record({ tool: 'smart_read', tokensReturned: 50, tokensWouldBe: 500, timestamp: Date.now(), savingsCategory: 'cache' });
      analytics.record({ tool: 'read_symbol', tokensReturned: 30, tokensWouldBe: 800, timestamp: Date.now(), savingsCategory: 'dedup' });

      const report = analytics.report();
      expect(report).toContain('Calls: 3');
      expect(report).toContain('SESSION ANALYTICS');
      // total saved: (900 + 450 + 770) = 2120 of 2300 → ~92%
      expect(report).toContain('92%');
    });

    it('shows cache hit count', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache' });
      analytics.record({ tool: 'read_symbol', tokensReturned: 50, tokensWouldBe: 500, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache' });

      const report = analytics.report();
      expect(report).toContain('Cache: 2/2 hits');
      expect(report).not.toContain('tokens served instantly');
    });

    it('shows overall savings when dedup calls present', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 30, tokensWouldBe: 800, timestamp: Date.now(), savingsCategory: 'dedup' });
      analytics.record({ tool: 'read_range', tokensReturned: 20, tokensWouldBe: 600, timestamp: Date.now(), savingsCategory: 'dedup' });
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 1000, timestamp: Date.now(), savingsCategory: 'compression' });

      const report = analytics.report();
      expect(report).toContain('Calls: 3');
      expect(report).toContain('SESSION ANALYTICS');
    });

    it('omits cache line when no cache hits', () => {
      const analytics = new SessionAnalytics();
      analytics.record({ tool: 'smart_read', tokensReturned: 100, tokensWouldBe: 100, timestamp: Date.now(), savingsCategory: 'none' });

      const report = analytics.report();
      expect(report).not.toContain('Cache:');
    });
  });
});
