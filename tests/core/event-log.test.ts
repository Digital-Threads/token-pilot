/**
 * Phase 6 subtasks 6.1 + 6.2 — event-log tests.
 *
 * Pure logic tested directly (shouldRotate, retentionDeletions); FS
 * wrappers tested with tmp dirs.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  readdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldRotate,
  retentionDeletions,
  appendEvent,
  loadEvents,
  applyRetention,
  ROTATION_THRESHOLD_BYTES,
  RETENTION_MAX_AGE_DAYS,
  RETENTION_MAX_TOTAL_BYTES,
  type HookEvent,
} from "../../src/core/event-log.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-eventlog-test-"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ─── shouldRotate (pure) ─────────────────────────────────────────────────────

describe("shouldRotate", () => {
  it("returns false when size is below threshold", () => {
    expect(shouldRotate({ size: 0 })).toBe(false);
    expect(shouldRotate({ size: 1000 })).toBe(false);
    expect(shouldRotate({ size: ROTATION_THRESHOLD_BYTES - 1 })).toBe(false);
  });

  it("returns true when size >= threshold", () => {
    expect(shouldRotate({ size: ROTATION_THRESHOLD_BYTES })).toBe(true);
    expect(shouldRotate({ size: ROTATION_THRESHOLD_BYTES + 1 })).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldRotate({ size: 500 }, 1000)).toBe(false);
    expect(shouldRotate({ size: 1000 }, 1000)).toBe(true);
  });
});

// ─── retentionDeletions (pure) ────────────────────────────────────────────────

describe("retentionDeletions", () => {
  const now = new Date("2026-04-18T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("returns empty when nothing is over age or size", () => {
    const files = [
      { path: "/a", mtime: daysAgo(1), size: 100 },
      { path: "/b", mtime: daysAgo(5), size: 200 },
    ];
    expect(retentionDeletions(files, now)).toEqual([]);
  });

  it("deletes files older than maxAgeDays", () => {
    const files = [
      { path: "/young", mtime: daysAgo(5), size: 100 },
      { path: "/old", mtime: daysAgo(35), size: 100 },
    ];
    expect(retentionDeletions(files, now)).toEqual(["/old"]);
  });

  it("enforces total size cap by deleting oldest first", () => {
    const files = [
      { path: "/newest", mtime: daysAgo(1), size: 60_000_000 },
      { path: "/middle", mtime: daysAgo(2), size: 30_000_000 },
      { path: "/oldest", mtime: daysAgo(3), size: 30_000_000 },
    ];
    // Total = 120 MB > 100 MB cap → delete oldest; 90 MB remaining ok.
    expect(retentionDeletions(files, now)).toEqual(["/oldest"]);
  });

  it("combines age + size: age-expired counted too", () => {
    const files = [
      { path: "/big-old", mtime: daysAgo(40), size: 80_000_000 },
      { path: "/small-recent", mtime: daysAgo(1), size: 30_000_000 },
    ];
    // big-old goes by age; remaining 30 MB under cap.
    expect(retentionDeletions(files, now)).toEqual(["/big-old"]);
  });

  it("respects custom ageDays and maxTotalBytes", () => {
    const files = [
      { path: "/a", mtime: daysAgo(10), size: 100 },
      { path: "/b", mtime: daysAgo(20), size: 200 },
    ];
    expect(
      retentionDeletions(files, now, 15, Number.POSITIVE_INFINITY),
    ).toEqual(["/b"]);
  });
});

// ─── appendEvent / loadEvents ─────────────────────────────────────────────────

describe("appendEvent / loadEvents", () => {
  it("round-trips a single event through JSONL", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);

    const event: HookEvent = {
      ts: 1_700_000_000_000,
      session_id: "s1",
      agent_type: null,
      agent_id: null,
      event: "denied",
      file: "src/big.ts",
      lines: 500,
      estTokens: 2000,
      summaryTokens: 400,
      savedTokens: 1600,
    };

    await appendEvent(project, event);
    const events = await loadEvents(project);
    expect(events).toEqual([event]);
  });

  it("appends multiple events in order", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);

    for (let i = 0; i < 3; i++) {
      await appendEvent(project, {
        ts: 1_700_000_000_000 + i,
        session_id: "s1",
        agent_type: null,
        agent_id: null,
        event: "denied",
        file: `a${i}.ts`,
        lines: 10,
        estTokens: 100,
        summaryTokens: 10,
        savedTokens: 90,
      });
    }
    const events = await loadEvents(project);
    expect(events.map((e) => e.file)).toEqual(["a0.ts", "a1.ts", "a2.ts"]);
  });

  it("loadEvents returns [] when file missing", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    expect(await loadEvents(project)).toEqual([]);
  });

  it("loadEvents skips malformed lines rather than throwing", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const logDir = join(project, ".token-pilot");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      join(logDir, "hook-events.jsonl"),
      `{"ts":1,"session_id":"s1","agent_type":null,"agent_id":null,"event":"denied","file":"ok.ts","lines":1,"estTokens":10,"summaryTokens":2,"savedTokens":8}\n` +
        `this is not json\n` +
        `{"ts":2,"session_id":"s1","agent_type":null,"agent_id":null,"event":"denied","file":"also-ok.ts","lines":2,"estTokens":20,"summaryTokens":4,"savedTokens":16}\n`,
    );
    const events = await loadEvents(project);
    expect(events.map((e) => e.file)).toEqual(["ok.ts", "also-ok.ts"]);
  });

  it("rotation: oversized current file is renamed before next append", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const logDir = join(project, ".token-pilot");
    await mkdir(logDir, { recursive: true });
    // Seed the current file over the (test) rotation threshold.
    const big = "x".repeat(12_000_000) + "\n";
    await writeFile(join(logDir, "hook-events.jsonl"), big);

    await appendEvent(project, {
      ts: Date.now(),
      session_id: "s1",
      agent_type: null,
      agent_id: null,
      event: "denied",
      file: "new.ts",
      lines: 1,
      estTokens: 10,
      summaryTokens: 2,
      savedTokens: 8,
    });

    const entries = await readdir(logDir);
    const archived = entries.find((f) => /^hook-events\.\d+\.jsonl$/.test(f));
    expect(
      archived,
      "expected an archived file with timestamped name",
    ).toBeTruthy();
    // Current file contains only the new event (one line).
    const current = await readFile(join(logDir, "hook-events.jsonl"), "utf-8");
    expect(current.split("\n").filter(Boolean)).toHaveLength(1);
    expect(current).toContain("new.ts");
  });
});

// ─── applyRetention ──────────────────────────────────────────────────────────

describe("applyRetention", () => {
  it("is a no-op when directory has no eligible deletions", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const logDir = join(project, ".token-pilot");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "hook-events.jsonl"), "line\n");
    await applyRetention(project);
    expect(await fileExists(join(logDir, "hook-events.jsonl"))).toBe(true);
  });

  it("is safe to call on a project with no .token-pilot dir", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    await expect(applyRetention(project)).resolves.toBeUndefined();
  });
});

// ─── defaults match acceptance ───────────────────────────────────────────────

describe("default constants match TP-c2a acceptance", () => {
  it("rotation threshold is 10 MB", () => {
    expect(ROTATION_THRESHOLD_BYTES).toBe(10_000_000);
  });
  it("retention age is 30 days", () => {
    expect(RETENTION_MAX_AGE_DAYS).toBe(30);
  });
  it("retention total cap is 100 MB", () => {
    expect(RETENTION_MAX_TOTAL_BYTES).toBe(100_000_000);
  });
});
