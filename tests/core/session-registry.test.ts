/**
 * TP-69m — session-scoped dedup.
 *
 * Before this change, `ContextRegistry` was process-scoped: it forgot
 * everything on MCP server restart. After, we keep a per-session registry
 * that is (a) isolated from other sessions and (b) persisted to disk so a
 * server restart or compaction doesn't throw away "we already loaded X".
 *
 * Contract tested:
 *   - Manager returns independent registries per session_id
 *   - State is persisted to .token-pilot/context-registries/<id>.json
 *   - Fresh manager reloads the persisted state
 *   - Evicts in-memory copies once cache cap is exceeded (disk still kept)
 *   - Unknown / empty sessionId → isolated ephemeral registry (no persistence)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionRegistryManager,
  REGISTRIES_SUBDIR,
} from "../../src/core/session-registry.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-session-registry-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionRegistryManager", () => {
  it("returns isolated registries per session_id", () => {
    const mgr = new SessionRegistryManager(tempDir, { inMemoryCap: 10 });
    const a = mgr.getFor("sess-a");
    const b = mgr.getFor("sess-b");
    expect(a).not.toBe(b);
    a.trackLoad("foo.ts", {
      type: "full",
      startLine: 1,
      endLine: 100,
      tokens: 500,
    });
    expect(a.hasAnyLoaded("foo.ts")).toBe(true);
    expect(b.hasAnyLoaded("foo.ts")).toBe(false);
  });

  it("persists tracked loads to disk", async () => {
    const mgr = new SessionRegistryManager(tempDir, { inMemoryCap: 10 });
    const reg = mgr.getFor("sess-persist");
    reg.trackLoad("src/foo.ts", {
      type: "symbol",
      symbolName: "helper",
      startLine: 10,
      endLine: 30,
      tokens: 120,
    });
    await mgr.flush("sess-persist");

    const path = join(tempDir, REGISTRIES_SUBDIR, "sess-persist.json");
    const s = await stat(path);
    expect(s.size).toBeGreaterThan(0);
  });

  it("reloads persisted state in a fresh manager", async () => {
    const mgr1 = new SessionRegistryManager(tempDir, { inMemoryCap: 10 });
    const reg1 = mgr1.getFor("sess-reload");
    reg1.trackLoad("src/reload.ts", {
      type: "full",
      startLine: 1,
      endLine: 50,
      tokens: 300,
    });
    reg1.setContentHash("src/reload.ts", "abc123");
    await mgr1.flush("sess-reload");

    const mgr2 = new SessionRegistryManager(tempDir, { inMemoryCap: 10 });
    const reg2 = mgr2.getFor("sess-reload");
    expect(reg2.hasAnyLoaded("src/reload.ts")).toBe(true);
    expect(reg2.isStale("src/reload.ts", "abc123")).toBe(false);
    expect(reg2.isStale("src/reload.ts", "changed")).toBe(true);
  });

  it("evicts least-recently-used session from memory when cap exceeded", () => {
    const mgr = new SessionRegistryManager(tempDir, { inMemoryCap: 2 });
    mgr.getFor("sess-1");
    mgr.getFor("sess-2");
    mgr.getFor("sess-3"); // sess-1 should be evicted
    expect(mgr.inMemoryIds()).toEqual(["sess-2", "sess-3"]);
  });

  it("ephemeral registry for empty sessionId — no disk write", async () => {
    const mgr = new SessionRegistryManager(tempDir, { inMemoryCap: 10 });
    const reg = mgr.getFor("");
    reg.trackLoad("x.ts", {
      type: "full",
      startLine: 1,
      endLine: 10,
      tokens: 50,
    });
    await mgr.flush("");
    const path = join(tempDir, REGISTRIES_SUBDIR, ".json");
    let exists = true;
    try {
      await stat(path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("rejects unsafe sessionIds (path traversal, slashes)", () => {
    const mgr = new SessionRegistryManager(tempDir, { inMemoryCap: 10 });
    const a = mgr.getFor("../escape");
    const b = mgr.getFor("ok/slash");
    // Both should resolve to ephemeral (no file created) rather than write
    // outside the registries dir.
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(mgr.inMemoryIds()).not.toContain("../escape");
    expect(mgr.inMemoryIds()).not.toContain("ok/slash");
  });
});
