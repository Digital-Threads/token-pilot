import { watch } from 'chokidar';
import { resolve } from 'node:path';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import type { AstIndexClient } from '../ast-index/client.js';

/**
 * Watches individual files for changes and auto-invalidates cache.
 * Only watches files that have been explicitly added (via watchFile()),
 * NOT the entire project root — avoids scanning thousands of files
 * and permission errors on Docker volumes, restricted dirs, etc.
 *
 * Also triggers debounced ast-index incremental update on file changes
 * to keep the index fresh for find_usages, find_unused, code_audit.
 */
export class FileWatcher {
  private static readonly UPDATE_DEBOUNCE_MS = 2000;

  private fileCache: FileCache;
  private contextRegistry: ContextRegistry;
  private astIndex: AstIndexClient | null;
  private watcher: ReturnType<typeof watch> | null = null;
  private watchedFiles = new Set<string>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private fileChangeCallback: ((absPath: string) => void) | null = null;
  private astUpdateCallback: (() => void) | null = null;

  constructor(
    _projectRoot: string,
    fileCache: FileCache,
    contextRegistry: ContextRegistry,
    _ignore: string[],
    astIndex?: AstIndexClient,
  ) {
    this.fileCache = fileCache;
    this.contextRegistry = contextRegistry;
    this.astIndex = astIndex ?? null;
  }

  start(): void {
    // Start with an empty watcher — files are added on demand via watchFile()
    this.watcher = watch([], {
      persistent: false,
      ignoreInitial: true,
    });

    this.watcher.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[token-pilot] file watcher error (ignored): ${msg}`);
    });

    this.watcher.on('change', (filePath: string) => {
      const absPath = resolve(filePath);
      if (this.fileCache.get(absPath)) {
        this.fileCache.invalidate(absPath);
      }
      this.fileChangeCallback?.(absPath);
      this.scheduleIndexUpdate();
    });

    this.watcher.on('unlink', (filePath: string) => {
      const absPath = resolve(filePath);
      this.fileCache.invalidate(absPath);
      this.contextRegistry.forget(absPath);
      this.watchedFiles.delete(absPath);
      this.fileChangeCallback?.(absPath);
      this.scheduleIndexUpdate();
    });
  }

  /** Debounced ast-index incremental update after file changes */
  private scheduleIndexUpdate(): void {
    if (!this.astIndex) return;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(async () => {
      try {
        await this.astIndex?.incrementalUpdate();
        this.astUpdateCallback?.();
      } catch { /* ignore */ }
    }, FileWatcher.UPDATE_DEBOUNCE_MS);
  }

  /** Register callback for file change/unlink events. */
  onFileChange(callback: (absPath: string) => void): void {
    this.fileChangeCallback = callback;
  }

  /** Register callback for after AST index incremental update completes. */
  onAstUpdate(callback: () => void): void {
    this.astUpdateCallback = callback;
  }

  /** Add a specific file to watch. Called after smart_read/read_symbol loads a file. */
  watchFile(filePath: string): void {
    const absPath = resolve(filePath);
    if (this.watchedFiles.has(absPath)) return;
    if (!this.watcher) return;

    this.watcher.add(absPath);
    this.watchedFiles.add(absPath);
  }

  stop(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.watchedFiles.clear();
  }
}
