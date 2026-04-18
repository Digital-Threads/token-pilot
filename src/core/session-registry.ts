/**
 * TP-69m — session-scoped ContextRegistry.
 *
 * The single `ContextRegistry` lived for the MCP server process lifetime,
 * so a restart — or the way Claude Code spawns short-lived server
 * instances — threw away "already loaded X" knowledge. This manager keeps
 * one registry per `session_id`, persists each to disk under
 * `.token-pilot/context-registries/<id>.json`, and LRU-evicts cold
 * sessions from memory.
 *
 * Session IDs that fail slug validation (empty, traversal, path separators)
 * get an ephemeral registry that is never persisted — a safe fallback for
 * callers that don't know their session_id yet.
 */

import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextRegistry } from "./context-registry.js";

export const REGISTRIES_SUBDIR = ".token-pilot/context-registries";
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface SessionRegistryManagerOptions {
  inMemoryCap?: number;
}

export class SessionRegistryManager {
  private readonly projectRoot: string;
  private readonly inMemoryCap: number;
  /** Insertion order = LRU order (re-insert on access). */
  private readonly live = new Map<string, ContextRegistry>();
  /** Ephemeral (unsafe-id / empty) registries are kept apart from the LRU. */
  private readonly ephemeral = new Map<string, ContextRegistry>();

  constructor(projectRoot: string, opts: SessionRegistryManagerOptions = {}) {
    this.projectRoot = projectRoot;
    this.inMemoryCap = opts.inMemoryCap ?? 8;
  }

  /**
   * Return the registry associated with a session id, creating / loading
   * as needed. Ephemeral for unsafe ids; otherwise LRU-cached and
   * disk-backed.
   */
  getFor(sessionId: string): ContextRegistry {
    if (!isSafeId(sessionId)) {
      let reg = this.ephemeral.get(sessionId);
      if (!reg) {
        reg = new ContextRegistry();
        this.ephemeral.set(sessionId, reg);
      }
      return reg;
    }

    const existing = this.live.get(sessionId);
    if (existing) {
      // Refresh LRU position.
      this.live.delete(sessionId);
      this.live.set(sessionId, existing);
      return existing;
    }

    const reg = new ContextRegistry();
    // Best-effort sync load from disk — hook path cannot await.
    const path = this.pathFor(sessionId);
    try {
      const raw = readFileSync(path, "utf-8");
      reg.loadSnapshot(JSON.parse(raw));
    } catch {
      /* no prior state, or corrupt file — start empty */
    }
    this.live.set(sessionId, reg);
    this.evict();
    return reg;
  }

  /** Flush one session's registry to disk. Silent on failure. */
  async flush(sessionId: string): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const reg = this.live.get(sessionId);
    if (!reg) return;
    const path = this.pathFor(sessionId);
    try {
      await fs.mkdir(join(this.projectRoot, REGISTRIES_SUBDIR), {
        recursive: true,
      });
      await fs.writeFile(path, JSON.stringify(reg.toSnapshot()));
    } catch {
      /* best-effort */
    }
  }

  /** Flush every live registry. Called on server shutdown. */
  async flushAll(): Promise<void> {
    const ids = Array.from(this.live.keys());
    for (const id of ids) await this.flush(id);
  }

  /** LRU insertion-order snapshot of in-memory session ids (for tests). */
  inMemoryIds(): string[] {
    return Array.from(this.live.keys());
  }

  private pathFor(sessionId: string): string {
    return join(this.projectRoot, REGISTRIES_SUBDIR, `${sessionId}.json`);
  }

  private evict(): void {
    while (this.live.size > this.inMemoryCap) {
      const oldest = this.live.keys().next().value;
      if (!oldest) break;
      // Best-effort async flush before dropping from memory.
      void this.flush(oldest);
      this.live.delete(oldest);
    }
  }
}

function isSafeId(id: string): boolean {
  if (!id) return false;
  return SAFE_ID_RE.test(id);
}
