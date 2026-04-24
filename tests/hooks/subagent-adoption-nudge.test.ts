/**
 * Tests for buildSubagentAdoptionNudge — the v0.32.0 SessionStart nudge
 * that fires when a user keeps dispatching general-purpose Task calls
 * on work a tp-* specialist would handle.
 *
 * Pure function; every case is constructed explicitly. We're testing:
 *   - window filtering (outside window → ignored)
 *   - minimum sample size (too few events → silent)
 *   - threshold check (below 50 % → silent)
 *   - top-miss-pair surfacing
 *   - empty / no-miss / all-tp- cases
 */
import { describe, expect, it } from "vitest";
import { buildSubagentAdoptionNudge } from "../../src/hooks/session-start.ts";
import type { HookEvent } from "../../src/core/event-log.ts";

const NOW = 1_800_000_000_000; // arbitrary reference time
const DAY = 86_400_000;

function task(overrides: Partial<HookEvent>): HookEvent {
  return {
    ts: NOW,
    session_id: "s",
    agent_type: null,
    agent_id: null,
    event: "task",
    file: "",
    lines: 0,
    estTokens: 0,
    summaryTokens: 0,
    savedTokens: 0,
    subagent_type: "general-purpose",
    matched_tp_agent: null,
    ...overrides,
  };
}

describe("buildSubagentAdoptionNudge", () => {
  it("returns null when fewer than minSample Task events", () => {
    const events = [
      task({ matched_tp_agent: "tp-pr-reviewer" }),
      task({ matched_tp_agent: "tp-debugger" }),
    ];
    expect(buildSubagentAdoptionNudge(events, NOW)).toBeNull();
  });

  it("returns null when miss-rate below threshold", () => {
    // 5 events, 1 miss → 20% < 50%
    const events = [
      task({ matched_tp_agent: "tp-pr-reviewer" }), // miss
      task({ subagent_type: "tp-pr-reviewer", matched_tp_agent: null }),
      task({ subagent_type: "tp-pr-reviewer", matched_tp_agent: null }),
      task({ subagent_type: "tp-debugger", matched_tp_agent: null }),
      task({ subagent_type: "tp-debugger", matched_tp_agent: null }),
    ];
    expect(buildSubagentAdoptionNudge(events, NOW)).toBeNull();
  });

  it("emits a nudge when miss-rate >= threshold and sample >= min", () => {
    const events = [
      task({ matched_tp_agent: "tp-pr-reviewer" }),
      task({ matched_tp_agent: "tp-pr-reviewer" }),
      task({ matched_tp_agent: "tp-test-writer" }),
      task({ subagent_type: "tp-pr-reviewer", matched_tp_agent: null }),
      task({ matched_tp_agent: "tp-debugger" }),
    ];
    const msg = buildSubagentAdoptionNudge(events, NOW);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/miss-rate 80%/);
    expect(msg).toMatch(/4\/5 Task calls/);
    expect(msg).toMatch(/TOKEN_PILOT_FORCE_SUBAGENTS/);
  });

  it("surfaces the top routing miss pair", () => {
    // 3 pr-reviewer misses, 2 test-writer → pr-reviewer is top.
    const events = [
      task({ matched_tp_agent: "tp-pr-reviewer" }),
      task({ matched_tp_agent: "tp-pr-reviewer" }),
      task({ matched_tp_agent: "tp-pr-reviewer" }),
      task({ matched_tp_agent: "tp-test-writer" }),
      task({ matched_tp_agent: "tp-test-writer" }),
    ];
    const msg = buildSubagentAdoptionNudge(events, NOW);
    expect(msg).toMatch(/Top miss: general-purpose → tp-pr-reviewer/);
  });

  it("ignores events outside the window", () => {
    // All misses but all old → silent.
    const old = NOW - 10 * DAY;
    const events = [
      task({ ts: old, matched_tp_agent: "tp-pr-reviewer" }),
      task({ ts: old, matched_tp_agent: "tp-pr-reviewer" }),
      task({ ts: old, matched_tp_agent: "tp-pr-reviewer" }),
      task({ ts: old, matched_tp_agent: "tp-pr-reviewer" }),
      task({ ts: old, matched_tp_agent: "tp-pr-reviewer" }),
    ];
    expect(buildSubagentAdoptionNudge(events, NOW, 7)).toBeNull();
  });

  it("ignores non-task events", () => {
    const events: HookEvent[] = [
      { ...task({ matched_tp_agent: "tp-pr-reviewer" }) },
      { ...task({ matched_tp_agent: "tp-pr-reviewer" }) },
      // Non-task event should be filtered out entirely.
      {
        ts: NOW,
        session_id: "s",
        agent_type: null,
        agent_id: null,
        event: "denied",
        file: "f.ts",
        lines: 10,
        estTokens: 100,
        summaryTokens: 20,
        savedTokens: 80,
      },
    ];
    // 2 task events — below minSample of 5 → null.
    expect(buildSubagentAdoptionNudge(events, NOW)).toBeNull();
  });

  it("returns null when no misses at all (all tp-* already)", () => {
    const events = Array.from({ length: 10 }, () =>
      task({ subagent_type: "tp-pr-reviewer", matched_tp_agent: null }),
    );
    expect(buildSubagentAdoptionNudge(events, NOW)).toBeNull();
  });
});
