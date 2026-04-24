/**
 * Phase 6 subtask 6.3 — `token-pilot stats` CLI tests.
 *
 * Covers the three views:
 *  - default  → totals + per-file breakdown
 *  - --session → events filtered to one session_id
 *  - --by-agent → grouped by agent_type, sorted by savedTokens desc
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, type HookEvent } from "../../src/core/event-log.js";
import { formatStats } from "../../src/cli/stats.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-stats-test-"));
}

function ev(overrides: Partial<HookEvent>): HookEvent {
  return {
    ts: Date.now(),
    session_id: "s1",
    agent_type: null,
    agent_id: null,
    event: "denied",
    file: "src/default.ts",
    lines: 100,
    estTokens: 1000,
    summaryTokens: 200,
    savedTokens: 800,
    ...overrides,
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ─── formatStats (pure) ──────────────────────────────────────────────────────

describe("formatStats — default view", () => {
  it("reports totals and per-file breakdown", () => {
    const events: HookEvent[] = [
      ev({ file: "a.ts", savedTokens: 500 }),
      ev({ file: "a.ts", savedTokens: 300 }),
      ev({ file: "b.ts", savedTokens: 100 }),
    ];
    const out = formatStats(events, {});
    expect(out).toMatch(/3 event/);
    expect(out).toMatch(/900 token/);
    expect(out).toMatch(/a\.ts.*800/);
    expect(out).toMatch(/b\.ts.*100/);
  });

  it("handles empty input gracefully", () => {
    const out = formatStats([], {});
    expect(out).toMatch(/no events/i);
  });
});

describe("formatStats — --session filter", () => {
  it("only includes events matching the given session_id", () => {
    const events: HookEvent[] = [
      ev({ session_id: "s1", file: "a.ts", savedTokens: 100 }),
      ev({ session_id: "s2", file: "b.ts", savedTokens: 200 }),
      ev({ session_id: "s1", file: "c.ts", savedTokens: 300 }),
    ];
    const out = formatStats(events, { session: "s1" });
    expect(out).toMatch(/2 event/);
    expect(out).toMatch(/400 token/);
    expect(out).toContain("a.ts");
    expect(out).toContain("c.ts");
    expect(out).not.toContain("b.ts");
  });

  it("picks the most recent session when --session is used without an argument", () => {
    const events: HookEvent[] = [
      ev({ session_id: "old", ts: 1, savedTokens: 100 }),
      ev({ session_id: "new", ts: 2, savedTokens: 200 }),
    ];
    // `session: true` means "most recent".
    const out = formatStats(events, { session: true });
    expect(out).toMatch(/new/);
    expect(out).toMatch(/200 token/);
    expect(out).not.toMatch(/^.*old.*$/m);
  });
});

describe("formatStats — --by-agent view", () => {
  it("groups by agent_type with null rendered as 'main'", () => {
    const events: HookEvent[] = [
      ev({ agent_type: null, savedTokens: 100 }),
      ev({ agent_type: "tp-run", savedTokens: 500 }),
      ev({ agent_type: "tp-run", savedTokens: 300 }),
      ev({ agent_type: "tp-onboard", savedTokens: 200 }),
    ];
    const out = formatStats(events, { byAgent: true });
    // Sorted desc by saved tokens.
    const order = [
      out.indexOf("tp-run"),
      out.indexOf("tp-onboard"),
      out.indexOf("main"),
    ];
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(out).toMatch(/tp-run.*800/);
    expect(out).toMatch(/tp-onboard.*200/);
    expect(out).toMatch(/main.*100/);
  });

  it("emits zero-agents line when there are no events", () => {
    expect(formatStats([], { byAgent: true })).toMatch(/no events/i);
  });
});

describe("formatStats — --tasks view (v0.31.0)", () => {
  function taskEv(overrides: Partial<HookEvent>): HookEvent {
    return ev({
      event: "task",
      file: "",
      lines: 0,
      savedTokens: 0,
      ...overrides,
    });
  }

  it("reports total Task calls, picked subagents, and miss-rate", () => {
    const events: HookEvent[] = [
      taskEv({
        subagent_type: "general-purpose",
        matched_tp_agent: "tp-pr-reviewer",
      }),
      taskEv({
        subagent_type: "general-purpose",
        matched_tp_agent: "tp-test-writer",
      }),
      taskEv({
        subagent_type: "tp-pr-reviewer",
        matched_tp_agent: null,
      }),
      taskEv({
        subagent_type: "general-purpose",
        matched_tp_agent: null, // no heuristic hit → not a miss
      }),
    ];
    const out = formatStats(events, { tasks: true });
    // 4 Task calls total, 2 misses (general-purpose → tp-*) = 50%.
    expect(out).toMatch(/4 Task call/);
    expect(out).toMatch(/miss-rate 50%/);
    expect(out).toMatch(/general-purpose.*3/);
    expect(out).toMatch(/tp-pr-reviewer.*1/);
    expect(out).toMatch(/general-purpose → tp-pr-reviewer/);
    expect(out).toMatch(/general-purpose → tp-test-writer/);
  });

  it("returns a friendly notice when no Task events are present", () => {
    const events: HookEvent[] = [
      ev({ event: "denied", file: "foo.ts", savedTokens: 10 }),
    ];
    const out = formatStats(events, { tasks: true });
    expect(out).toMatch(/no Task events/i);
  });

  it("ignores non-Task events even when mixed in", () => {
    const events: HookEvent[] = [
      ev({ event: "denied", file: "a.ts", savedTokens: 900 }),
      taskEv({
        subagent_type: "general-purpose",
        matched_tp_agent: "tp-debugger",
      }),
    ];
    const out = formatStats(events, { tasks: true });
    expect(out).toMatch(/1 Task call/);
    expect(out).toMatch(/miss-rate 100%/);
    expect(out).not.toMatch(/a\.ts/);
  });

  it("0% miss-rate when all Task calls already use tp-*", () => {
    const events: HookEvent[] = [
      taskEv({ subagent_type: "tp-pr-reviewer", matched_tp_agent: null }),
      taskEv({ subagent_type: "tp-test-writer", matched_tp_agent: null }),
    ];
    const out = formatStats(events, { tasks: true });
    expect(out).toMatch(/miss-rate 0%/);
  });
});

// ─── integration via event-log ───────────────────────────────────────────────

describe("stats reads from event-log", () => {
  it("formatStats on loaded events mirrors the default view", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);

    await appendEvent(
      dir,
      ev({ file: "x.ts", savedTokens: 900, session_id: "abc" }),
    );
    await appendEvent(
      dir,
      ev({ file: "y.ts", savedTokens: 100, session_id: "abc" }),
    );

    const { loadEvents } = await import("../../src/core/event-log.js");
    const events = await loadEvents(dir);
    expect(events).toHaveLength(2);
    expect(formatStats(events, {})).toMatch(/1000 token/);
  });
});
