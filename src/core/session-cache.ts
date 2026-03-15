import { createHash } from 'node:crypto';

export interface SessionCacheEntry {
  /** Cached handler result */
  result: { content: Array<{ type: string; text: string }>; [key: string]: unknown };
  /** Absolute file paths (or dir prefixes ending with '/') this result depends on */
  fileDeps: Set<string>;
  /** Invalidate when AST index rebuilds */
  dependsOnAst: boolean;
  /** Invalidate when git state changes (branch switch, new commits) */
  dependsOnGit: boolean;
  /** When this entry was cached */
  cachedAt: number;
  /** Estimated token count of the result */
  tokenEstimate: number;
}

export interface SessionCacheDeps {
  files?: string[];
  dependsOnAst?: boolean;
  dependsOnGit?: boolean;
}

export class SessionCache {
  private entries = new Map<string, SessionCacheEntry>();
  /** Reverse index: file path → set of cache keys that depend on it */
  private fileDepsIndex = new Map<string, Set<string>>();
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(private maxEntries: number) {}

  /**
   * Generate deterministic cache key from tool name + args.
   * Sorts args keys for consistency regardless of insertion order.
   */
  static makeCacheKey(tool: string, args: object): string {
    const sorted = JSON.stringify(args, Object.keys(args).sort());
    const hash = createHash('sha256').update(sorted).digest('hex').slice(0, 16);
    return `${tool}:${hash}`;
  }

  /** Try to get a cached result. Returns null on miss. */
  get(tool: string, args: object): SessionCacheEntry | null {
    const key = SessionCache.makeCacheKey(tool, args);
    const entry = this.entries.get(key);
    if (entry) {
      this.hits++;
      return entry;
    }
    this.misses++;
    return null;
  }

  /** Store a result with its dependency metadata. */
  set(
    tool: string,
    args: object,
    result: { content: Array<{ type: string; text: string }>; [key: string]: unknown },
    deps: SessionCacheDeps,
    tokenEstimate: number,
  ): void {
    // LRU eviction if full
    if (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }

    const key = SessionCache.makeCacheKey(tool, args);
    const fileDeps = new Set(deps.files ?? []);

    const entry: SessionCacheEntry = {
      result,
      fileDeps,
      dependsOnAst: deps.dependsOnAst ?? false,
      dependsOnGit: deps.dependsOnGit ?? false,
      cachedAt: Date.now(),
      tokenEstimate,
    };

    this.entries.set(key, entry);

    // Update reverse index
    for (const dep of fileDeps) {
      let keys = this.fileDepsIndex.get(dep);
      if (!keys) {
        keys = new Set();
        this.fileDepsIndex.set(dep, keys);
      }
      keys.add(key);
    }
  }

  /**
   * Invalidate all entries that depend on any of the given files.
   * Checks both exact path match and directory prefix match.
   */
  invalidateByFiles(filePaths: string[]): number {
    let count = 0;
    const keysToDelete = new Set<string>();

    for (const changedFile of filePaths) {
      // Exact match from reverse index
      const exactKeys = this.fileDepsIndex.get(changedFile);
      if (exactKeys) {
        for (const key of exactKeys) keysToDelete.add(key);
      }

      // Directory prefix match: check if changedFile is under any cached dir dep
      for (const [dep, keys] of this.fileDepsIndex) {
        if (dep.endsWith('/') && changedFile.startsWith(dep)) {
          for (const key of keys) keysToDelete.add(key);
        }
      }
    }

    for (const key of keysToDelete) {
      this.deleteEntry(key);
      count++;
    }
    this.invalidations += count;
    return count;
  }

  /** Invalidate all entries that depend on AST index state. */
  invalidateByAst(): number {
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.dependsOnAst) {
        this.deleteEntry(key);
        count++;
      }
    }
    this.invalidations += count;
    return count;
  }

  /** Invalidate all entries that depend on git state. */
  invalidateByGit(): number {
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.dependsOnGit) {
        this.deleteEntry(key);
        count++;
      }
    }
    this.invalidations += count;
    return count;
  }

  /** Clear all entries. */
  invalidateAll(): void {
    const count = this.entries.size;
    this.entries.clear();
    this.fileDepsIndex.clear();
    this.invalidations += count;
  }

  /** Cache statistics for analytics. */
  stats(): { entries: number; hits: number; misses: number; hitRate: number; invalidations: number } {
    const total = this.hits + this.misses;
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) : 0,
      invalidations: this.invalidations,
    };
  }

  // --- Private helpers ---

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    // Clean up reverse index
    for (const dep of entry.fileDeps) {
      const keys = this.fileDepsIndex.get(dep);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.fileDepsIndex.delete(dep);
      }
    }
    this.entries.delete(key);
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.deleteEntry(oldestKey);
    }
  }
}
