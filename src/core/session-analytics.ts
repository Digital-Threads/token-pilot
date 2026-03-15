import { formatDuration } from './format-duration.js';
import type { ContextModeStatus } from '../integration/context-mode-detector.js';

export type SavingsCategory = 'compression' | 'cache' | 'dedup' | 'none';

export interface ToolCall {
  tool: string;
  path?: string;
  tokensReturned: number;
  tokensWouldBe: number;
  timestamp: number;
  delegatedToContextMode?: boolean;
  sessionCacheHit?: boolean;
  savingsCategory?: SavingsCategory;
}

/**
 * Tracks token savings and tool usage across a session.
 * When context-mode is detected, includes unified reporting.
 */
export class SessionAnalytics {
  private calls: ToolCall[] = [];
  private sessionStart = Date.now();
  private contextModeStatus: ContextModeStatus = { detected: false, source: 'none', toolPrefix: '' };

  setContextModeStatus(status: ContextModeStatus): void {
    this.contextModeStatus = status;
  }

  record(call: ToolCall): void {
    this.calls.push(call);
  }

  /**
   * Generate a session report.
   */
  report(): string {
    const duration = formatDuration(Date.now() - this.sessionStart);
    const totalReturned = this.calls.reduce((s, c) => s + c.tokensReturned, 0);
    const totalWouldBe = this.calls.reduce((s, c) => s + c.tokensWouldBe, 0);
    const saved = totalWouldBe > 0 ? Math.round((1 - totalReturned / totalWouldBe) * 100) : 0;

    // Group by tool
    const byTool = new Map<string, { count: number; tokens: number; saved: number; wouldBe: number }>();
    for (const c of this.calls) {
      const existing = byTool.get(c.tool) ?? { count: 0, tokens: 0, saved: 0, wouldBe: 0 };
      existing.count++;
      existing.tokens += c.tokensReturned;
      existing.saved += Math.max(0, c.tokensWouldBe - c.tokensReturned);
      existing.wouldBe += c.tokensWouldBe;
      byTool.set(c.tool, existing);
    }

    const lines: string[] = [
      `SESSION ANALYTICS (${duration})`,
      '',
      `Total tool calls: ${this.calls.length}`,
      `Tokens returned: ~${totalReturned}`,
      `Tokens saved: ~${totalWouldBe - totalReturned} (${saved}% reduction)`,
      '',
      'By tool:',
    ];

    const sortedTools = Array.from(byTool.entries()).sort((a, b) => b[1].saved - a[1].saved);
    for (const [tool, stats] of sortedTools) {
      const reduction = stats.wouldBe > 0
        ? Math.round((1 - stats.tokens / stats.wouldBe) * 100)
        : 0;
      lines.push(`  ${tool}: ${stats.count} calls, ~${stats.tokens} tokens returned, ~${stats.saved} saved (${reduction}% reduction)`);
    }

    // Top files by savings
    const byFile = new Map<string, number>();
    for (const c of this.calls) {
      if (c.path) {
        const current = byFile.get(c.path) ?? 0;
        byFile.set(c.path, current + Math.max(0, c.tokensWouldBe - c.tokensReturned));
      }
    }

    const topFiles = Array.from(byFile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topFiles.length > 0) {
      lines.push('');
      lines.push('Top files by savings:');
      for (const [file, saved] of topFiles) {
        lines.push(`  ${file}: ~${saved} tokens saved`);
      }
    }

    const lowValueTools = sortedTools
      .map(([tool, stats]) => ({
        tool,
        reduction: stats.wouldBe > 0 ? Math.round((1 - stats.tokens / stats.wouldBe) * 100) : 0,
        count: stats.count,
      }))
      .filter((tool) => tool.reduction < 20);

    if (lowValueTools.length > 0) {
      lines.push('');
      lines.push('Needs improvement:');
      for (const tool of lowValueTools.slice(0, 5)) {
        lines.push(`  ${tool.tool}: only ${tool.reduction}% reduction across ${tool.count} call${tool.count === 1 ? '' : 's'}`);
      }
    }

    // Savings breakdown by category
    const byCategory: Record<SavingsCategory, number> = { compression: 0, cache: 0, dedup: 0, none: 0 };
    for (const c of this.calls) {
      const cat = c.savingsCategory ?? 'none';
      byCategory[cat] += Math.max(0, c.tokensWouldBe - c.tokensReturned);
    }
    if (totalWouldBe > totalReturned) {
      lines.push('');
      lines.push('Savings breakdown:');
      if (byCategory.compression > 0) lines.push(`  Compression (AST/structured): ~${byCategory.compression} tokens`);
      if (byCategory.cache > 0) lines.push(`  Cache hits (session cache): ~${byCategory.cache} tokens`);
      if (byCategory.dedup > 0) lines.push(`  Dedup (already in context): ~${byCategory.dedup} tokens`);
    }

    // Session cache hits
    const cacheHits = this.calls.filter(c => c.sessionCacheHit);
    if (cacheHits.length > 0) {
      const cacheTokensSaved = cacheHits.reduce((s, c) => s + Math.max(0, c.tokensWouldBe - c.tokensReturned), 0);
      lines.push('');
      lines.push(`Session cache: ${cacheHits.length} hits / ${this.calls.length} calls (${Math.round(cacheHits.length / this.calls.length * 100)}% hit rate, ~${cacheTokensSaved} tokens saved)`);
    }

    // Dedup reminders served
    const dedupCalls = this.calls.filter(c => c.savingsCategory === 'dedup');
    if (dedupCalls.length > 0) {
      lines.push('');
      lines.push(`Compact reminders/dedup: ${dedupCalls.length} calls (avoided full re-reads)`);
    }

    // Delegation stats
    const delegated = this.calls.filter(c => c.delegatedToContextMode);
    if (delegated.length > 0) {
      lines.push('');
      lines.push(`Delegated to context-mode: ${delegated.length} calls`);
    }

    // Context-mode companion status
    if (this.contextModeStatus.detected) {
      lines.push('');
      lines.push('--- Combined Architecture ---');
      lines.push(`context-mode: active (detected via ${this.contextModeStatus.source})`);
      lines.push('Token Pilot handles: code files (AST-level structural reading)');
      lines.push('context-mode handles: shell output, logs, large data files (BM25-indexed)');
      lines.push('TIP: Use /context-mode:stats for context-mode savings breakdown.');
    }

    return lines.join('\n');
  }

  reset(): void {
    this.calls = [];
    this.sessionStart = Date.now();
  }
}
