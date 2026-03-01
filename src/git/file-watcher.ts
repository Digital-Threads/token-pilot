import { watch } from 'chokidar';
import { resolve } from 'node:path';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';

/**
 * Watches individual files for changes and auto-invalidates cache.
 * Only watches files that have been explicitly added (via watchFile()),
 * NOT the entire project root — avoids scanning thousands of files
 * and permission errors on Docker volumes, restricted dirs, etc.
 */
export class FileWatcher {
  private fileCache: FileCache;
  private contextRegistry: ContextRegistry;
  private watcher: ReturnType<typeof watch> | null = null;
  private watchedFiles = new Set<string>();

  constructor(
    _projectRoot: string,
    fileCache: FileCache,
    contextRegistry: ContextRegistry,
    _ignore: string[],
  ) {
    this.fileCache = fileCache;
    this.contextRegistry = contextRegistry;
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
    });

    this.watcher.on('unlink', (filePath: string) => {
      const absPath = resolve(filePath);
      this.fileCache.invalidate(absPath);
      this.contextRegistry.forget(absPath);
      this.watchedFiles.delete(absPath);
    });
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
    this.watcher?.close();
    this.watcher = null;
    this.watchedFiles.clear();
  }
}
