/**
 * v0.26.4 — profile recommender tests.
 *
 * Covers: the decision matrix (nav / edit / full / low-confidence), the
 * min-samples gate (MIN_SAMPLE_CALLS = 20 — too-small sample never
 * recommends narrower than full), and format rendering.
 */
import { describe, it, expect } from "vitest";
import {
  recommendProfile,
  formatRecommendation,
} from "../../src/server/profile-recommender.ts";
import type { ToolCallEvent } from "../../src/core/tool-call-log.ts";

function ev(
  tool: string,
  overrides: Partial<ToolCallEvent> = {},
): ToolCallEvent {
  return {
    ts: 0,
    session_id: "s",
    tool,
    tokensReturned: 100,
    tokensWouldBe: 500,
    savingsCategory: "compression",
    ...overrides,
  };
}

function many(tool: string, n: number): ToolCallEvent[] {
  return Array.from({ length: n }, () => ev(tool));
}

describe("recommendProfile", () => {
  it("returns lowConfidence+full when sample is too small", () => {
    // 5 calls < MIN_SAMPLE_CALLS (20)
    const events = many("smart_read", 5);
    const r = recommendProfile(events);
    expect(r.recommended).toBe("full");
    expect(r.lowConfidence).toBe(true);
    expect(r.reason).toMatch(/too small|≥20|Only/i);
  });

  it("recommends `full` even for nav-only usage — no trim trap (v0.45.0, 26b)", () => {
    // 30 calls, only nav tools used — old behaviour recommended `nav`, which
    // hid edit tools the rules reference and trapped the next edit session.
    const events = [
      ...many("smart_read", 15),
      ...many("outline", 8),
      ...many("find_usages", 7),
    ];
    const r = recommendProfile(events);
    expect(r.recommended).toBe("full");
    expect(r.lowConfidence).toBe(false);
    expect(r.uniqueToolsSeen).toBe(3);
    expect(r.totalCalls).toBe(30);
    expect(r.reason).toMatch(/No such tool|stay on full|edit/i);
  });

  it("recommends `full` for edit-prep usage (does not push the edit trim)", () => {
    // 25 calls: nav + read_for_edit + read_symbols, no code_audit etc
    const events = [
      ...many("smart_read", 10),
      ...many("read_for_edit", 8),
      ...many("read_symbols", 5),
      ...many("smart_diff", 2),
    ];
    const r = recommendProfile(events);
    expect(r.recommended).toBe("full");
    expect(r.lowConfidence).toBe(false);
    expect(r.reason).toMatch(/full|audit|edit-prep/i);
  });

  it("recommends `full` when user touches any full-only tool", () => {
    const events = [
      ...many("smart_read", 15),
      ...many("read_for_edit", 5),
      ...many("test_summary", 2), // full-only
    ];
    const r = recommendProfile(events);
    expect(r.recommended).toBe("full");
    expect(r.lowConfidence).toBe(false);
    expect(r.reason).toMatch(/test_summary|full-only|actually use/i);
  });

  it("honestly names the full-only tools in the reason", () => {
    const events = [
      ...many("smart_read", 20),
      ...many("find_unused", 3),
      ...many("code_audit", 3),
    ];
    const r = recommendProfile(events);
    expect(r.recommended).toBe("full");
    expect(r.reason).toMatch(/find_unused|code_audit/);
  });

  it("exactly at MIN_SAMPLE_CALLS boundary behaves correctly", () => {
    // Exactly 20 calls, all nav → enough data, but recommends full (no trim trap)
    const events = many("smart_read", 20);
    const r = recommendProfile(events);
    expect(r.recommended).toBe("full");
    expect(r.lowConfidence).toBe(false);
  });

  it("returns totalCalls=0 cleanly for empty input (no crash)", () => {
    const r = recommendProfile([]);
    expect(r.totalCalls).toBe(0);
    expect(r.uniqueToolsSeen).toBe(0);
    expect(r.recommended).toBe("full");
    expect(r.lowConfidence).toBe(true);
  });
});

describe("formatRecommendation", () => {
  it("never prints an apply-trim snippet — even for nav-only usage (26b)", () => {
    const rec = recommendProfile(many("smart_read", 30));
    const out = formatRecommendation(rec);
    expect(out).toMatch(/TOKEN_PILOT_PROFILE=full/);
    // The old trap: "apply: add env TOKEN_PILOT_PROFILE=nav to .mcp.json".
    expect(out).not.toMatch(/TOKEN_PILOT_PROFILE=nav/);
    expect(out).not.toMatch(/apply:/);
    expect(out).not.toMatch(/savings:/);
  });

  it("edit-prep usage recommends full, not a trim", () => {
    const rec = recommendProfile([
      ...many("smart_read", 15),
      ...many("read_for_edit", 10),
    ]);
    const out = formatRecommendation(rec);
    expect(out).toMatch(/TOKEN_PILOT_PROFILE=full/);
    expect(out).not.toMatch(/TOKEN_PILOT_PROFILE=edit/);
  });

  it("low-confidence reco tells user to come back later", () => {
    const rec = recommendProfile(many("smart_read", 3));
    const out = formatRecommendation(rec);
    expect(out).toMatch(/keep default/);
    expect(out).toMatch(/after a few real sessions/);
  });

  it("full recommendation with real data doesn't push a switch", () => {
    const rec = recommendProfile([
      ...many("smart_read", 20),
      ...many("test_summary", 5),
    ]);
    const out = formatRecommendation(rec);
    expect(out).toMatch(/keep default/);
    expect(out).not.toMatch(/savings:/); // no savings promise when staying on full
  });
});
