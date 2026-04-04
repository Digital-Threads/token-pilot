import type { ContextEntry, LoadedRegion, SymbolInfo } from '../types.js';
import { estimateTokens } from './token-estimator.js';
import { formatDuration } from './format-duration.js';

/**
 * Advisory Context Registry.
 * Tracks what was sent to the LLM but never blocks re-sends.
 * The MCP server cannot know the true state of the LLM's context window.
 */
export class ContextRegistry {
  private entries = new Map<string, ContextEntry>();
  private sessionStart = Date.now();

  trackLoad(path: string, region: LoadedRegion): void {
    const existing = this.entries.get(path);

    if (existing) {
      // Replace region of same type/symbol, add new ones
      const idx = existing.loaded.findIndex(
        r => r.type === region.type && r.symbolName === region.symbolName
      );
      if (idx >= 0) {
        existing.loaded[idx] = region;
      } else {
        existing.loaded.push(region);
      }
      existing.tokenEstimate = existing.loaded.reduce((sum, r) => sum + r.tokens, 0);
      existing.loadedAt = Date.now();
    } else {
      this.entries.set(path, {
        path,
        loaded: [region],
        contentHash: '',
        tokenEstimate: region.tokens,
        loadedAt: Date.now(),
      });
    }
  }

  setContentHash(path: string, hash: string): void {
    const entry = this.entries.get(path);
    if (entry) {
      entry.contentHash = hash;
    }
  }

  getLoaded(path: string): LoadedRegion[] | null {
    const entry = this.entries.get(path);
    return entry?.loaded ?? null;
  }

  isSymbolLoaded(path: string, symbolName: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;
    return entry.loaded.some(r => r.symbolName === symbolName);
  }

  /** Check if any region of a file has been loaded into context. */
  hasAnyLoaded(path: string): boolean {
    const entry = this.entries.get(path);
    return !!entry && entry.loaded.length > 0;
  }

  isStale(path: string, currentHash: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return true;
    // Empty hash means setContentHash was never called — treat as stale
    if (!entry.contentHash) return true;
    return entry.contentHash !== currentHash;
  }

  /**
   * Generate a compact reminder for previously loaded content.
   * Returns a brief summary instead of full re-read.
   */
  compactReminder(path: string, symbols: SymbolInfo[]): string {
    const entry = this.entries.get(path);
    if (!entry) return '';

    const elapsed = formatDuration(Date.now() - entry.loadedAt);
    const lines: string[] = [
      `REMINDER: ${path} (previously loaded ${elapsed} ago, unchanged)`,
      '',
    ];

    for (const region of entry.loaded) {
      if (region.type === 'structure') {
        lines.push(`  Structure loaded (${region.tokens} tokens)`);
        // Add brief symbol list
        for (const sym of symbols.slice(0, 5)) {
          lines.push(`    ${sym.kind} ${sym.name} [L${sym.location.startLine}-${sym.location.endLine}]`);
        }
        if (symbols.length > 5) {
          lines.push(`    ... (${symbols.length - 5} more symbols)`);
        }
      } else if (region.type === 'symbol' && region.symbolName) {
        lines.push(`  ${region.symbolName} [L${region.startLine}-${region.endLine}] (${region.tokens} tokens)`);
      } else if (region.type === 'full') {
        lines.push(`  Full file loaded (${region.tokens} tokens)`);
      }
    }

    lines.push('');
    lines.push('HINT: File unchanged since last read. Use read_symbol() to reload specific parts, or read_diff() to see changes.');

    return lines.join('\n');
  }

  /** Check if file was loaded in full (type='full' region exists). */
  isFullyLoaded(path: string): boolean {
    const entry = this.entries.get(path);
    if (!entry) return false;
    return entry.loaded.some(r => r.type === 'full');
  }

  /**
   * Generate a compact dedup reminder for read_symbol.
   * Fires when same symbol was already loaded OR full file is in context.
   */
  symbolReminder(path: string, symbolName: string): string {
    const entry = this.entries.get(path);
    if (!entry) return '';

    const elapsed = formatDuration(Date.now() - entry.loadedAt);
    const symbolRegion = entry.loaded.find(r => r.symbolName === symbolName);
    const fullRegion = entry.loaded.find(r => r.type === 'full');

    if (fullRegion) {
      const loc = symbolRegion ? ` Symbol at [L${symbolRegion.startLine}-${symbolRegion.endLine}].` : '';
      return [
        `DEDUP: "${symbolName}" in ${path} — full file already in context (loaded ${elapsed} ago, ${fullRegion.tokens} tokens, unchanged).${loc}`,
        'HINT: File unchanged. No need to re-read. Use read_for_edit() if you need exact code for editing.',
      ].join('\n');
    }

    if (symbolRegion) {
      return [
        `DEDUP: "${symbolName}" in ${path} — already loaded ${elapsed} ago [L${symbolRegion.startLine}-${symbolRegion.endLine}] (${symbolRegion.tokens} tokens, unchanged).`,
        'HINT: Symbol unchanged since last read. No need to re-read.',
      ].join('\n');
    }

    return '';
  }

  /**
   * Generate a compact dedup reminder for read_range.
   * Only fires when full file is in context.
   */
  rangeReminder(path: string, startLine: number, endLine: number): string {
    const entry = this.entries.get(path);
    if (!entry) return '';

    const fullRegion = entry.loaded.find(r => r.type === 'full');
    if (!fullRegion) return '';

    const elapsed = formatDuration(Date.now() - entry.loadedAt);
    return [
      `DEDUP: ${path} [L${startLine}-${endLine}] — full file already in context (loaded ${elapsed} ago, ${fullRegion.tokens} tokens, unchanged).`,
      'HINT: File unchanged. No need to re-read. Use read_for_edit() if you need exact code for editing.',
    ].join('\n');
  }

  forget(path: string, symbolName?: string): void {
    if (symbolName) {
      const entry = this.entries.get(path);
      if (entry) {
        entry.loaded = entry.loaded.filter(r => r.symbolName !== symbolName);
        if (entry.loaded.length === 0) {
          this.entries.delete(path);
        } else {
          entry.tokenEstimate = entry.loaded.reduce((sum, r) => sum + r.tokens, 0);
        }
      }
    } else {
      this.entries.delete(path);
    }
  }

  forgetAll(): void {
    this.entries.clear();
  }

  summary(): { files: number; totalTokens: number; sessionDuration: number; entries: ContextEntry[] } {
    const allEntries = Array.from(this.entries.values());
    return {
      files: allEntries.length,
      totalTokens: allEntries.reduce((sum, e) => sum + e.tokenEstimate, 0),
      sessionDuration: Date.now() - this.sessionStart,
      entries: allEntries,
    };
  }

  estimateTokens(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.tokenEstimate;
    }
    return total;
  }

  trackStructureSymbols(path: string, symbolNames: string[]): void {
    const entry = this.entries.get(path);
    if (entry) {
      entry.symbolNames = symbolNames;
    }
  }

  getSymbolNames(path: string): string[] | undefined {
    return this.entries.get(path)?.symbolNames;
  }

  /** Get the timestamp when a file was last loaded into context. */
  getLoadedAt(path: string): number | undefined {
    return this.entries.get(path)?.loadedAt;
  }

  invalidateByGitDiff(changedFiles: string[]): void {
    for (const file of changedFiles) {
      this.entries.delete(file);
    }
  }

}
