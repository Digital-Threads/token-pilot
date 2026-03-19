import { formatDuration } from './format-duration.js';
import type { ContextModeStatus } from '../integration/context-mode-detector.js';
import type { Intent } from './intent-classifier.js';
import type { DecisionTrace } from './decision-trace.js';

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
   * Generate a compact session report (~5 lines).
   */
  report(): string {
    const duration = formatDuration(Date.now() - this.sessionStart);
    const totalReturned = this.calls.reduce((s, c) => s + c.tokensReturned, 0);
    const totalWouldBe = this.calls.reduce((s, c) => s + c.tokensWouldBe, 0);
    const saved = totalWouldBe > 0 ? Math.round((1 - totalReturned / totalWouldBe) * 100) : 0;

    const lines: string[] = [
      `SESSION ANALYTICS (${duration})`,
      `Calls: ${this.calls.length}  ·  Tokens returned: ~${totalReturned}  ·  Saved: ~${totalWouldBe - totalReturned} (${saved}%)`,
    ];

    // By tool — top 5 by savings, all on one line
    if (this.calls.length > 0) {
      const byTool = new Map<string, { count: number; tokens: number; wouldBe: number }>();
      for (const c of this.calls) {
        const e = byTool.get(c.tool) ?? { count: 0, tokens: 0, wouldBe: 0 };
        e.count++;
        e.tokens += c.tokensReturned;
        e.wouldBe += c.tokensWouldBe;
        byTool.set(c.tool, e);
      }
      const sorted = Array.from(byTool.entries())
        .sort((a, b) => (b[1].wouldBe - b[1].tokens) - (a[1].wouldBe - a[1].tokens))
        .slice(0, 5);
      const toolParts = sorted.map(([tool, s]) => {
        const pct = s.wouldBe > 0 ? Math.round((1 - s.tokens / s.wouldBe) * 100) : 0;
        return `${tool} ${s.count}× (${pct}%)`;
      });
      lines.push(`Tools: ${toolParts.join('  ·  ')}`);
    }

    // Top files by savings (top 3)
    const byFile = new Map<string, number>();
    for (const c of this.calls) {
      if (c.path) {
        byFile.set(c.path, (byFile.get(c.path) ?? 0) + Math.max(0, c.tokensWouldBe - c.tokensReturned));
      }
    }
    const topFiles = Array.from(byFile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (topFiles.length > 0) {
      const fileParts = topFiles.map(([f, s]) => `${f} ~${s}`);
      lines.push(`Top files: ${fileParts.join('  ·  ')}`);
    }

    // Cache hits + context-mode on one line
    const extras: string[] = [];
    const cacheHits = this.calls.filter(c => c.sessionCacheHit);
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

    return lines.join('\n');
  }

  reset(): void {
    this.calls = [];
    this.sessionStart = Date.now();
  }
}
