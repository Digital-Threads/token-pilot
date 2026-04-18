/**
 * v0.26.2 — persistent MCP tool-call log.
 *
 * Covers: append/load roundtrip, JSONL tolerance (malformed lines),
 * retention by age, retention by size, file-missing graceful load.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
  mkdir,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendToolCall,
  loadAllToolCalls,
  currentToolLogPath,
  retentionDeletions,
  applyRetention,
  type ToolCallEvent,
} from "../../src/core/tool-call-log.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-toollog-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function mkEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    ts: Date.now(),
    session_id: "s1",
    tool: "smart_read",
    path: "src/foo.ts",
    tokensReturned: 100,
    tokensWouldBe: 500,
    savingsCategory: "compression",
    ...overrides,
  };
}

describe("appendToolCall + loadAllToolCalls", () => {
  it("roundtrip: one event in, one event out", async () => {
    await appendToolCall(tempDir, mkEvent());
    const events = await loadAllToolCalls(tempDir);
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe("smart_read");
    expect(events[0].tokensReturned).toBe(100);
  });

  it("roundtrip: multiple events preserve order", async () => {
    await appendToolCall(tempDir, mkEvent({ tool: "smart_read", ts: 1 }));
    await appendToolCall(tempDir, mkEvent({ tool: "find_usages", ts: 2 }));
    await appendToolCall(tempDir, mkEvent({ tool: "read_symbol", ts: 3 }));
    const events = await loadAllToolCalls(tempDir);
    expect(events.map((e) => e.tool)).toEqual([
      "smart_read",
      "find_usages",
      "read_symbol",
    ]);
  });

  it("returns [] for missing directory", async () => {
    const missingDir = join(tempDir, "does-not-exist");
    const events = await loadAllToolCalls(missingDir);
    expect(events).toEqual([]);
  });

  it("skips malformed JSONL lines without poisoning the dataset", async () => {
    await appendToolCall(tempDir, mkEvent({ tool: "good1", ts: 1 }));
    // Corrupt the file manually
    const p = currentToolLogPath(tempDir);
    const existing = await readFile(p, "utf-8");
    await writeFile(
      p,
      existing +
        "{broken json\n" +
        JSON.stringify(mkEvent({ tool: "good2", ts: 2 })) +
        "\n",
    );
    const events = await loadAllToolCalls(tempDir);
    expect(events.map((e) => e.tool)).toEqual(["good1", "good2"]);
  });

  it("persists across simulated sessions (separate appends)", async () => {
    // Session 1
    await appendToolCall(tempDir, mkEvent({ session_id: "A", ts: 1 }));
    await appendToolCall(tempDir, mkEvent({ session_id: "A", ts: 2 }));
    // Session 2 (new process would append to the same file)
    await appendToolCall(tempDir, mkEvent({ session_id: "B", ts: 3 }));
    const events = await loadAllToolCalls(tempDir);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.session_id)).toEqual(["A", "A", "B"]);
  });
});

describe("retentionDeletions (pure)", () => {
  const now = new Date("2026-04-18T00:00:00Z");
  const day = 86_400_000;

  it("deletes files older than maxAgeDays", () => {
    const files = [
      { path: "old.jsonl", mtime: new Date(now.getTime() - 40 * day), size: 1 },
      {
        path: "fresh.jsonl",
        mtime: new Date(now.getTime() - 5 * day),
        size: 1,
      },
    ];
    const victims = retentionDeletions(files, now, 30, 1_000_000_000);
    expect(victims).toEqual(["old.jsonl"]);
  });

  it("deletes oldest-first when total size exceeds maxTotalBytes", () => {
    const files = [
      {
        path: "oldest.jsonl",
        mtime: new Date(now.getTime() - 10 * day),
        size: 600,
      },
      {
        path: "middle.jsonl",
        mtime: new Date(now.getTime() - 5 * day),
        size: 600,
      },
      {
        path: "newest.jsonl",
        mtime: new Date(now.getTime() - 1 * day),
        size: 600,
      },
    ];
    // cap = 1000, total = 1800, need to shed 800 → removes oldest (600)
    // but that leaves 1200 > 1000, so also removes middle (600) → 600 <= 1000 ✓
    const victims = retentionDeletions(files, now, 365, 1000);
    expect(victims.sort()).toEqual(["middle.jsonl", "oldest.jsonl"]);
  });

  it("no-op when everything is fresh and small", () => {
    const files = [
      { path: "a.jsonl", mtime: new Date(now.getTime() - 1 * day), size: 10 },
      { path: "b.jsonl", mtime: new Date(now.getTime() - 2 * day), size: 10 },
    ];
    expect(retentionDeletions(files, now, 30, 1_000_000)).toEqual([]);
  });
});

describe("applyRetention (end-to-end)", () => {
  it("removes stale archive files, leaves current + fresh archives", async () => {
    const logDir = join(tempDir, ".token-pilot");
    await mkdir(logDir, { recursive: true });

    const current = currentToolLogPath(tempDir);
    await writeFile(current, JSON.stringify(mkEvent()) + "\n");

    const old = join(logDir, "tool-calls.1600000000000.jsonl"); // 2020
    await writeFile(old, "{}\n");
    // Mark file mtime as 2020 so the 30-day retention actually trips it.
    // writeFile sets mtime = now; utimes backdates it.
    const oldDate = new Date("2020-09-13T00:00:00Z");
    await utimes(old, oldDate, oldDate);

    const fresh = join(logDir, `tool-calls.${Date.now()}.jsonl`);
    await writeFile(fresh, "{}\n");

    await applyRetention(tempDir);

    // fresh archive + current survive; old archive deleted
    await stat(current); // no throw
    await stat(fresh); // no throw
    await expect(stat(old)).rejects.toThrow();
  });
});
