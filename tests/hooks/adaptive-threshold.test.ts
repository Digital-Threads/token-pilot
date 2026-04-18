/**
 * TP-bbo — adaptive threshold tests.
 *
 * Given the total savedTokens accumulated so far in the current session
 * (from hook-events.jsonl), lower the effective denyThreshold so the
 * hook gets stricter as session budget drains.
 *
 * Tuning curve (piecewise linear):
 *   burned <  30% of budget → base threshold unchanged
 *   burned ≥  30%, < 60%    → base × 0.75
 *   burned ≥  60%, < 80%    → base × 0.5
 *   burned ≥  80%           → base × 0.3  (minimum 50 lines floor)
 *
 * Opt-in only: when the config flag is off, always return base.
 */
import { describe, it, expect } from "vitest";
import { computeEffectiveThreshold } from "../../src/hooks/adaptive-threshold.ts";

describe("computeEffectiveThreshold", () => {
  it("returns base threshold when adaptive mode is off", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 80000,
        sessionBudgetTokens: 100000,
        enabled: false,
      }),
    ).toBe(300);
  });

  it("no change when burn is below 30 percent", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 20000,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(300);
  });

  it("tightens to ~75 percent of base at 30-60 percent burn", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 40000,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(225);
  });

  it("tightens to ~50 percent of base at 60-80 percent burn", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 70000,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(150);
  });

  it("tightens hard at 80+ percent burn but floors at 50 lines", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 95000,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(90);

    // Small base + heavy burn should still keep a sane minimum.
    expect(
      computeEffectiveThreshold({
        baseThreshold: 100,
        sessionSavedTokens: 99000,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(50);
  });

  it("clamps unrealistic burn values (> 100 percent or negative)", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 200000,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(90); // same as >=80 band
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: -5,
        sessionBudgetTokens: 100000,
        enabled: true,
      }),
    ).toBe(300);
  });

  it("gracefully handles zero or missing budget", () => {
    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 50000,
        sessionBudgetTokens: 0,
        enabled: true,
      }),
    ).toBe(300); // no budget → no burn signal → base

    expect(
      computeEffectiveThreshold({
        baseThreshold: 300,
        sessionSavedTokens: 50000,
        sessionBudgetTokens: -1,
        enabled: true,
      }),
    ).toBe(300);
  });
});
