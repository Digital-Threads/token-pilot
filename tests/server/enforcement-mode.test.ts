/**
 * v0.30.0 — TOKEN_PILOT_MODE enforcement mode tests.
 *
 * Covers: parseEnforcementMode parsing (valid values, case-insensitive,
 * whitespace trimming, unknown-value fallback with warning, empty/missing
 * → deny default), and the exported constants.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseEnforcementMode,
  ENFORCEMENT_MODE_NAMES,
  STRICT_SMART_READ_MAX_TOKENS,
  STRICT_EXPLORE_AREA_INCLUDE,
} from "../../src/server/enforcement-mode.ts";

describe("parseEnforcementMode", () => {
  it("undefined → deny (default, no warning)", () => {
    const warn = vi.fn();
    expect(parseEnforcementMode(undefined, warn)).toBe("deny");
    expect(warn).not.toHaveBeenCalled();
  });

  it("empty string → deny (default, no warning)", () => {
    const warn = vi.fn();
    expect(parseEnforcementMode("", warn)).toBe("deny");
    expect(warn).not.toHaveBeenCalled();
  });

  it("whitespace-only → deny (default, no warning)", () => {
    const warn = vi.fn();
    expect(parseEnforcementMode("   ", warn)).toBe("deny");
    expect(warn).not.toHaveBeenCalled();
  });

  it("case-insensitive: ADVISORY, Deny, STRICT all work", () => {
    expect(parseEnforcementMode("ADVISORY")).toBe("advisory");
    expect(parseEnforcementMode("Deny")).toBe("deny");
    expect(parseEnforcementMode("STRICT")).toBe("strict");
  });

  it("whitespace is trimmed", () => {
    expect(parseEnforcementMode("  advisory  ")).toBe("advisory");
    expect(parseEnforcementMode("  strict  ")).toBe("strict");
  });

  it("unknown value → deny AND emits a warning", () => {
    const warn = vi.fn();
    expect(parseEnforcementMode("paranoid", warn)).toBe("deny");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/TOKEN_PILOT_MODE="paranoid"/);
    expect(warn.mock.calls[0][0]).toMatch(/advisory | deny | strict/);
  });

  it("ENFORCEMENT_MODE_NAMES lists all three modes", () => {
    expect([...ENFORCEMENT_MODE_NAMES].sort()).toEqual([
      "advisory",
      "deny",
      "strict",
    ]);
  });
});

describe("strict mode constants", () => {
  it("STRICT_SMART_READ_MAX_TOKENS is a positive number", () => {
    expect(STRICT_SMART_READ_MAX_TOKENS).toBeGreaterThan(0);
    expect(typeof STRICT_SMART_READ_MAX_TOKENS).toBe("number");
  });

  it("STRICT_SMART_READ_MAX_TOKENS is 2000 (v0.30.0 initial estimate)", () => {
    expect(STRICT_SMART_READ_MAX_TOKENS).toBe(2000);
  });

  it("STRICT_EXPLORE_AREA_INCLUDE is ['outline']", () => {
    expect(STRICT_EXPLORE_AREA_INCLUDE).toEqual(["outline"]);
  });
});
