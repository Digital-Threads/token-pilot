import { formatDuration } from './format-duration.js';
import type { ContextModeStatus } from '../integration/context-mode-detector.js';
import type { Intent } from './intent-classifier.js';
import type { DecisionTrace } from './decision-trace.js';
import { ALL_INTENTS } from './intent-classifier.js';

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
  intent?: Intent;
  decisionTrace?: DecisionTrace;
}

export type { Intent, DecisionTrace };

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
   * Generate session report. Compact by default (~5 lines), verbose=true for full breakdown.
   */
  report(verbose = false): string {
    const duration = formatDuration(Date.now() - this.sessionStart);
    const totalReturned = this.calls.reduce((s, c) => s + c.tokensReturned, 0);
    const totalWouldBe = this.calls.reduce((s, c) => s + c.tokensWouldBe, 0);
    const saved = totalWouldBe > 0 ? Math.round((1 - totalReturned / totalWouldBe) * 100) : 0;

    // --- Shared data ---
    const byTool = new Map<string, { count: number; tokens: number; saved: number; wouldBe: number }>();
    for (const c of this.calls) {
      const e = byTool.get(c.tool) ?? { count: 0, tokens: 0, saved: 0, wouldBe: 0 };
      e.count++;
      e.tokens += c.tokensReturned;
      e.saved += Math.max(0, c.tokensWouldBe - c.tokensReturned);
      e.wouldBe += c.tokensWouldBe;
      byTool.set(c.tool, e);
    }
    const sortedTools = Array.from(byTool.entries()).sort((a, b) => b[1].saved - a[1].saved);

    const byFile = new Map<string, number>();
    for (const c of this.calls) {
      if (c.path) {
        byFile.set(c.path, (byFile.get(c.path) ?? 0) + Math.max(0, c.tokensWouldBe - c.tokensReturned));
      }
    }

    const cacheHits = this.calls.filter(c => c.sessionCacheHit);

    // --- Compact report ---
    const lines: string[] = [
      `SESSION ANALYTICS (${duration})`,
      `Calls: ${this.calls.length}  ·  Tokens returned: ~${totalReturned}  ·  Saved: ~${totalWouldBe - totalReturned} (${saved}%)`,
    ];

    if (this.calls.length > 0) {
      const toolParts = sortedTools.slice(0, 5).map(([tool, s]) => {
        const pct = s.wouldBe > 0 ? Math.round((1 - s.tokens / s.wouldBe) * 100) : 0;
        return `${tool} ${s.count}× (${pct}%)`;
      });
      lines.push(`Tools: ${toolParts.join('  ·  ')}`);
    }

    const topFiles = Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (topFiles.length > 0) {
      const fileParts = topFiles.map(([f, s]) => `${f} ~${s}`);
      lines.push(`Top files: ${fileParts.join('  ·  ')}`);
    }

    const extras: string[] = [];
    if (cacheHits.length > 0) {
      const hitRate = Math.round(cacheHits.length / this.calls.length * 100);
      extras.push(`Cache: ${cacheHits.length}/${this.calls.length} hits (${hitRate}%)`);
    }
    if (this.contextModeStatus.detected) {
      extras.push(`context-mode: active (${this.contextModeStatus.source})`);
    }
    if (extras.length > 0) {
      lines.push(extras.join('  ·  '));
    }

    if (!verbose) return lines.join('\n');

    // --- Verbose additions ---
    lines.push('');
    lines.push('--- DETAILED BREAKDOWN ---');

    // Full per-tool table
    if (sortedTools.length > 0) {
      lines.push('');
      lines.push('By tool:');
      for (const [tool, stats] of sortedTools) {
        const reduction = stats.wouldBe > 0 ? Math.round((1 - stats.tokens / stats.wouldBe) * 100) : 0;
        lines.push(`  ${tool}: ${stats.count} calls, ~${stats.tokens} tokens returned, ~${stats.saved} saved (${reduction}%)`);
      }
    }

    // Top 5 files
    const allTopFiles = Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (allTopFiles.length > 0) {
      lines.push('');
      lines.push('Top files by savings:');
      for (const [file, fileSaved] of allTopFiles) {
        lines.push(`  ${file}: ~${fileSaved} tokens saved`);
      }
    }

    // Low-value tools
    const lowValue = sortedTools
      .map(([tool, stats]) => ({
        tool,
        reduction: stats.wouldBe > 0 ? Math.round((1 - stats.tokens / stats.wouldBe) * 100) : 0,
        count: stats.count,
      }))
      .filter(t => t.reduction < 20);
    if (lowValue.length > 0) {
      lines.push('');
      lines.push('Needs improvement:');
      for (const t of lowValue.slice(0, 5)) {
        lines.push(`  ${t.tool}: only ${t.reduction}% reduction across ${t.count} call${t.count === 1 ? '' : 's'}`);
      }
    }

    // Savings by category
    const byCategory: Record<SavingsCategory, number> = { compression: 0, cache: 0, dedup: 0, none: 0 };
    for (const c of this.calls) {
      byCategory[c.savingsCategory ?? 'none'] += Math.max(0, c.tokensWouldBe - c.tokensReturned);
    }
    if (totalWouldBe > totalReturned) {
      lines.push('');
      lines.push('Savings breakdown:');
      if (byCategory.compression > 0) lines.push(`  Compression (AST/structured): ~${byCategory.compression} tokens`);
      if (byCategory.cache > 0) lines.push(`  Cache hits (session cache): ~${byCategory.cache} tokens`);
      if (byCategory.dedup > 0) lines.push(`  Dedup (already in context): ~${byCategory.dedup} tokens`);
    }

    // Session cache detail
    if (cacheHits.length > 0) {
      const cacheTokensSaved = cacheHits.reduce((s, c) => s + Math.max(0, c.tokensWouldBe - c.tokensReturned), 0);
      lines.push('');
      lines.push(`Session cache: ${cacheHits.length} hits / ${this.calls.length} calls (${Math.round(cacheHits.length / this.calls.length * 100)}% hit rate, ~${cacheTokensSaved} tokens saved)`);
    }

    // Delegation
    const delegated = this.calls.filter(c => c.delegatedToContextMode);
    if (delegated.length > 0) {
      lines.push(`Delegated to context-mode: ${delegated.length} calls`);
    }

    // Per-intent breakdown
    const callsWithIntent = this.calls.filter(c => c.intent);
    if (callsWithIntent.length > 0) {
      const byIntent = new Map<string, { count: number; saved: number }>();
      for (const c of callsWithIntent) {
        const intent = c.intent!;
        const e = byIntent.get(intent) ?? { count: 0, saved: 0 };
        e.count++;
        e.saved += Math.max(0, c.tokensWouldBe - c.tokensReturned);
        byIntent.set(intent, e);
      }
      lines.push('');
      lines.push('Per-intent breakdown:');
      for (const intent of ALL_INTENTS) {
        const stats = byIntent.get(intent);
        if (stats) {
          lines.push(`  ${intent}: ${stats.count} call${stats.count === 1 ? '' : 's'}, ~${stats.saved} tokens saved`);
        }
      }
    }

    // Decision insights
    const tracedCalls = this.calls.filter(c => c.decisionTrace);
    if (tracedCalls.length > 0) {
      const alreadyInContext = tracedCalls.filter(c => c.decisionTrace!.alreadyInContext).length;
      const totalEstimated = tracedCalls.reduce((s, c) => s + c.decisionTrace!.estimatedCost, 0);
      const totalActual = tracedCalls.reduce((s, c) => s + c.decisionTrace!.actualCost, 0);
      const avgReduction = totalEstimated > 0 ? Math.round((1 - totalActual / totalEstimated) * 100) : 0;
      const missedSavings = tracedCalls.filter(c => c.decisionTrace!.cheaperAlternative).length;

      lines.push('');
      lines.push('Decision insights:');
      lines.push(`  Files already in context: ${alreadyInContext} of ${tracedCalls.length} calls (${Math.round(alreadyInContext / tracedCalls.length * 100)}%)`);
      lines.push(`  Avg cost reduction: ${avgReduction}% (estimated → actual)`);
      if (missedSavings > 0) {
        lines.push(`  Missed savings: ${missedSavings} call${missedSavings === 1 ? '' : 's'} could have used cheaper tools`);
      }
    }

    // Context-mode
    if (this.contextModeStatus.detected) {
      lines.push('');
      lines.push('--- Combined Architecture ---');
      lines.push(`context-mode: active (detected via ${this.contextModeStatus.source})`);
      lines.push('Token Pilot handles: code files (AST-level structural reading)');
      lines.push('context-mode handles: shell output, logs, large data files (BM25-indexed)');
    }

    return lines.join('\n');
  }

  reset(): void {
    this.calls = [];
    this.sessionStart = Date.now();
  }
}
