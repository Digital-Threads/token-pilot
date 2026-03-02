import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { CacheEntry, FileStructure } from '../types.js';

export class FileCache {
  private cache = new Map<string, CacheEntry>();
  private maxSizeBytes: number;
  private currentSizeBytes = 0;
  private smallFileThreshold: number;
  private hits = 0;
  private misses = 0;
  private onSetCallback: ((filePath: string) => void) | null = null;

  constructor(maxSizeMB = 100, smallFileThreshold = 200) {
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;
    this.smallFileThreshold = smallFileThreshold;
  }

  /** Register a callback invoked whenever a file is cached (used by FileWatcher). */
  onSet(callback: (filePath: string) => void): void {
    this.onSetCallback = callback;
  }

  get(filePath: string): CacheEntry | null {
    const entry = this.cache.get(filePath);
    if (!entry) {
      this.misses++;
      return null;
    }
    entry.lastAccess = Date.now();
    this.hits++;
    return entry;
  }

  set(filePath: string, entry: CacheEntry): void {
    const existingSize = this.cache.get(filePath)?.content.length ?? 0;
    const newSize = entry.content.length;

    // Evict LRU if needed
    while (this.currentSizeBytes - existingSize + newSize > this.maxSizeBytes && this.cache.size > 0) {
      this.evictLRU();
    }

    if (existingSize > 0) {
      this.currentSizeBytes -= existingSize;
    }

    this.cache.set(filePath, entry);
    this.currentSizeBytes += newSize;
    this.onSetCallback?.(filePath);
  }

  async isSmallFile(filePath: string): Promise<boolean> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return content.split('\n').length <= this.smallFileThreshold;
    } catch {
      return false;
    }
  }

  async isStale(filePath: string): Promise<boolean> {
    const entry = this.cache.get(filePath);
    if (!entry) return true;

    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs !== entry.mtime) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  invalidate(filePath?: string): void {
    if (filePath) {
      const entry = this.cache.get(filePath);
      if (entry) {
        this.currentSizeBytes -= entry.content.length;
        this.cache.delete(filePath);
      }
    } else {
      this.cache.clear();
      this.currentSizeBytes = 0;
    }
  }

  async invalidateByGitDiff(changedFiles: string[]): Promise<void> {
    for (const file of changedFiles) {
      this.invalidate(file);
    }
  }

  stats(): { entries: number; sizeBytes: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      sizeBytes: this.currentSizeBytes,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  getSmallFileThreshold(): number {
    return this.smallFileThreshold;
  }

  cachedPaths(): string[] {
    return Array.from(this.cache.keys());
  }

  private evictLRU(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [path, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldest = path;
      }
    }

    if (oldest) {
      this.invalidate(oldest);
    }
  }
}

/**
 * Read a file and create a cache-ready content hash.
 */
export async function readFileWithHash(filePath: string): Promise<{
  content: string;
  lines: string[];
  hash: string;
  mtime: number;
}> {
  const content = await readFile(filePath, 'utf-8');
  const fileStat = await stat(filePath);
  return {
    content,
    lines: content.split('\n'),
    hash: createHash('sha256').update(content).digest('hex'),
    mtime: fileStat.mtimeMs,
  };
}
