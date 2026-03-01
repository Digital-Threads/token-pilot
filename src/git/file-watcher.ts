import { watch } from 'chokidar';
import { resolve, extname } from 'node:path';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';

/**
 * Watches project files for changes and auto-invalidates cache.
 * Only watches files that are currently cached to avoid unnecessary overhead.
 */
export class FileWatcher {
  private projectRoot: string;
  private fileCache: FileCache;
  private contextRegistry: ContextRegistry;
  private watcher: ReturnType<typeof watch> | null = null;
  private ignore: string[];

  constructor(
    projectRoot: string,
    fileCache: FileCache,
    contextRegistry: ContextRegistry,
    ignore: string[],
  ) {
    this.projectRoot = projectRoot;
    this.fileCache = fileCache;
    this.contextRegistry = contextRegistry;
    this.ignore = ignore;
  }

  start(): void {
    this.watcher = watch(this.projectRoot, {
      persistent: false,
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/__pycache__/**',
        '**/target/**', // Rust
        ...this.ignore.map(p => resolve(this.projectRoot, p)),
      ],
      depth: 10,
    });

    this.watcher.on('error', (err: unknown) => {
      // Ignore permission errors (e.g. Docker volumes, restricted dirs)
      // Don't crash the server — file watching is best-effort
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[token-pilot] file watcher error (ignored): ${msg}`);
    });

    this.watcher.on('change', (filePath: string) => {
      // Invalidate only if this file is in cache
      const absPath = resolve(filePath);
      if (this.fileCache.get(absPath)) {
        this.fileCache.invalidate(absPath);
        // Don't invalidate context registry — the advisory reminder will
        // detect staleness via content hash mismatch
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      const absPath = resolve(filePath);
      this.fileCache.invalidate(absPath);
      this.contextRegistry.forget(absPath);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
