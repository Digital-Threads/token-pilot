/**
 * v0.26.2 — `npx token-pilot tool-audit` tests.
 *
 * Covers: pure aggregation math, low-value flagging threshold, JSON
 * output shape, empty-dataset message, end-to-end through runToolAudit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateToolCalls,
  formatTable,
  runToolAudit,
} from "../../src/cli/tool-audit.ts";
import { appendToolCall } from "../../src/core/tool-call-log.ts";
import type { ToolCallEvent } from "../../src/core/tool-call-log.ts";

function mk(e: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    ts: 0,
    session_id: "s",
    tool: "smart_read",
    tokensReturned: 100,
    tokensWouldBe: 500,
    savingsCategory: "compression",
    ...e,
  };
}

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-audit-"));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("aggregateToolCalls (pure)", () => {
  it("groups by tool and sums tokens correctly", () => {
    const events = [
      mk({ tool: "smart_read", tokensReturned: 100, tokensWouldBe: 500 }),
      mk({ tool: "smart_read", tokensReturned: 200, tokensWouldBe: 1000 }),
      mk({ tool: "find_usages", tokensReturned: 50, tokensWouldBe: 2000 }),
    ];
    const rows = aggregateToolCalls(events);

    const findUsages = rows.find((r) => r.tool === "find_usages")!;
    expect(findUsages.count).toBe(1);
    expect(findUsages.tokensReturned).toBe(50);
    expect(findUsages.tokensWouldBe).toBe(2000);
    expect(findUsages.saved).toBe(1950);
    expect(findUsages.reductionPct).toBe(98);

    const smartRead = rows.find((r) => r.tool === "smart_read")!;
    expect(smartRead.count).toBe(2);
    expect(smartRead.tokensReturned).toBe(300);
    expect(smartRead.tokensWouldBe).toBe(1500);
    expect(smartRead.saved).toBe(1200);
    expect(smartRead.reductionPct).toBe(80);
  });

  it("sorts rows by tokens-saved desc (biggest contributor first)", () => {
    const events = [
      mk({ tool: "small", tokensReturned: 1, tokensWouldBe: 10 }), // 9 saved
      mk({ tool: "big", tokensReturned: 10, tokensWouldBe: 10_000 }), // 9990 saved
      mk({ tool: "mid", tokensReturned: 100, tokensWouldBe: 1000 }), // 900 saved
    ];
    const rows = aggregateToolCalls(events);
    expect(rows.map((r) => r.tool)).toEqual(["big", "mid", "small"]);
  });

  it("flags lowValue ONLY when reduction<20% AND ≥5 samples (avoid n=1 false alarms)", () => {
    // 6 calls, reduction = 10% → flagged
    const flaggedEvents = Array.from({ length: 6 }, () =>
      mk({ tool: "bad", tokensReturned: 90, tokensWouldBe: 100 }),
    );
    // 2 calls, reduction = 5% → NOT flagged (too few samples)
    const unflaggedEvents = Array.from({ length: 2 }, () =>
      mk({ tool: "new", tokensReturned: 95, tokensWouldBe: 100 }),
    );
    const rows = aggregateToolCalls([...flaggedEvents, ...unflaggedEvents]);

    expect(rows.find((r) => r.tool === "bad")!.lowValue).toBe(true);
    expect(rows.find((r) => r.tool === "new")!.lowValue).toBe(false);
  });

  it("counts noneCalls separately (pass-through honesty)", () => {
    const events = [
      mk({ tool: "smart_read", savingsCategory: "compression" }),
      mk({ tool: "smart_read", savingsCategory: "none" }),
      mk({ tool: "smart_read", savingsCategory: "none" }),
    ];
    const rows = aggregateToolCalls(events);
    expect(rows[0].noneCalls).toBe(2);
    expect(rows[0].count).toBe(3);
  });

  it("reduction=0 when wouldBe=0 (avoids NaN)", () => {
    const events = [mk({ tool: "x", tokensReturned: 0, tokensWouldBe: 0 })];
    const rows = aggregateToolCalls(events);
    expect(rows[0].reductionPct).toBe(0);
    expect(rows[0].saved).toBe(0);
  });
});

describe("formatTable (pure)", () => {
  it("empty dataset returns a helpful hint, not an empty string", () => {
    const out = formatTable([], { totalEvents: 0 });
    expect(out).toMatch(/No tool calls recorded yet/);
    expect(out).toMatch(/tool-audit/);
  });

  it("includes headers + rows + low-value footer when present", () => {
    const events = Array.from({ length: 5 }, () =>
      mk({ tool: "poor", tokensReturned: 90, tokensWouldBe: 100 }),
    );
    events.push(mk({ tool: "great", tokensReturned: 10, tokensWouldBe: 1000 }));
    const rows = aggregateToolCalls(events);
    const out = formatTable(rows, { totalEvents: 6 });

    expect(out).toMatch(/Token Pilot — tool audit/);
    expect(out).toMatch(/poor/);
    expect(out).toMatch(/great/);
    expect(out).toMatch(/low-value/); // flagged line
    expect(out).toMatch(/Low-value tools/); // footer explanation
  });
});

describe("runToolAudit (e2e)", () => {
  it("reads from disk and returns rows + stdout", async () => {
    await appendToolCall(
      tempDir,
      mk({ tool: "smart_read", tokensReturned: 100, tokensWouldBe: 500 }),
    );
    await appendToolCall(
      tempDir,
      mk({ tool: "find_usages", tokensReturned: 20, tokensWouldBe: 2000 }),
    );

    const { stdout, exitCode, rows } = await runToolAudit({
      projectRoot: tempDir,
    });

    expect(exitCode).toBe(0);
    expect(rows).toHaveLength(2);
    expect(stdout).toMatch(/smart_read/);
    expect(stdout).toMatch(/find_usages/);
  });

  it("--json mode emits parseable JSON with totalEvents + tools", async () => {
    await appendToolCall(tempDir, mk({ tool: "smart_read" }));
    const { stdout } = await runToolAudit({
      projectRoot: tempDir,
      json: true,
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.totalEvents).toBe(1);
    expect(parsed.tools[0].tool).toBe("smart_read");
  });

  it("empty project: no crash, returns the helpful hint", async () => {
    const { stdout, exitCode } = await runToolAudit({ projectRoot: tempDir });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No tool calls recorded yet/);
  });
});
