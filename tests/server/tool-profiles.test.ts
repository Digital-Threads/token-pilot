/**
 * v0.26.3 — tool profiles.
 *
 * Covers: profile filtering math (nav ⊂ edit ⊂ full), unknown env
 * fallback, the public guarantee that `full` returns the same list it
 * got (no accidental drop of future tools), and that `nav` doesn't
 * accidentally include edit-only tools.
 */
import { describe, it, expect, vi } from "vitest";
import {
  filterToolsByProfile,
  parseProfileEnv,
  PROFILE_NAMES,
  type ToolProfile,
} from "../../src/server/tool-profiles.ts";

type FakeTool = { name: string };

function tools(...names: string[]): FakeTool[] {
  return names.map((name) => ({ name }));
}

describe("filterToolsByProfile", () => {
  it('profile="full" returns the input list verbatim', () => {
    const input = tools("smart_read", "read_symbol", "exotic_future_tool");
    const out = filterToolsByProfile(input, "full");
    expect(out).toEqual(input);
  });

  it('profile="nav" keeps navigation-class tools + META tools', () => {
    const input = tools(
      "smart_read",
      "outline",
      "find_usages",
      "read_for_edit", // edit-only
      "read_symbols", // edit-only (batch)
      "test_summary", // full-only
      "session_analytics", // META — must stay
      "session_budget", // META — must stay
    );
    const out = filterToolsByProfile(input, "nav");
    const names = out.map((t) => t.name);
    expect(names).toContain("smart_read");
    expect(names).toContain("outline");
    expect(names).toContain("find_usages");
    // META tools are always visible — needed to verify the profile is
    // actually saving anything
    expect(names).toContain("session_analytics");
    expect(names).toContain("session_budget");
    // edit-only and full-only still excluded
    expect(names).not.toContain("read_for_edit");
    expect(names).not.toContain("read_symbols");
    expect(names).not.toContain("test_summary");
  });

  it('profile="minimal" keeps only the 5 core tools, no META', () => {
    const input = tools(
      "smart_read",
      "read_symbol",
      "find_usages",
      "smart_diff",
      "smart_log",
      "outline", // nav-only, excluded from minimal
      "read_for_edit", // edit-only, excluded
      "session_analytics", // META — excluded in minimal to keep footprint tiny
    );
    const out = filterToolsByProfile(input, "minimal");
    const names = out.map((t) => t.name);
    expect(names).toContain("smart_read");
    expect(names).toContain("read_symbol");
    expect(names).toContain("find_usages");
    expect(names).toContain("smart_diff");
    expect(names).toContain("smart_log");
    expect(names).not.toContain("outline");
    expect(names).not.toContain("read_for_edit");
    // META excluded from minimal — the whole point is minimal footprint
    expect(names).not.toContain("session_analytics");
  });

  it("META_TOOLS always visible in nav/edit/full profiles", () => {
    const input = tools(
      "smart_read",
      "session_analytics",
      "session_budget",
      "session_snapshot",
    );
    for (const profile of ["nav", "edit", "full"] as const) {
      const names = filterToolsByProfile(input, profile).map((t) => t.name);
      expect(names, `profile=${profile}`).toContain("session_analytics");
      expect(names, `profile=${profile}`).toContain("session_budget");
      expect(names, `profile=${profile}`).toContain("session_snapshot");
    }
    // minimal intentionally excludes META for context-budget reasons
    const minimalNames = filterToolsByProfile(input, "minimal").map(
      (t) => t.name,
    );
    expect(minimalNames).not.toContain("session_analytics");
  });

  it('profile="edit" keeps nav + edit-prep tools, still drops full-only', () => {
    const input = tools(
      "smart_read",
      "read_for_edit",
      "read_symbols",
      "smart_read_many",
      "test_summary", // full-only, must drop
      "find_unused", // full-only, must drop
    );
    const out = filterToolsByProfile(input, "edit");
    const names = out.map((t) => t.name);
    expect(names).toContain("smart_read");
    expect(names).toContain("read_for_edit");
    expect(names).toContain("read_symbols");
    expect(names).toContain("smart_read_many");
    expect(names).not.toContain("test_summary");
    expect(names).not.toContain("find_unused");
  });

  it("nav ⊂ edit ⊂ full (containment invariant)", () => {
    const all = tools(
      "smart_read",
      "read_symbol",
      "outline",
      "find_usages",
      "read_symbols",
      "read_range",
      "read_for_edit",
      "test_summary",
      "session_analytics",
    );
    const navNames = new Set(
      filterToolsByProfile(all, "nav").map((t) => t.name),
    );
    const editNames = new Set(
      filterToolsByProfile(all, "edit").map((t) => t.name),
    );
    const fullNames = new Set(
      filterToolsByProfile(all, "full").map((t) => t.name),
    );
    // nav ⊂ edit
    for (const n of navNames) expect(editNames.has(n)).toBe(true);
    // edit ⊂ full
    for (const n of editNames) expect(fullNames.has(n)).toBe(true);
    // strict containment: edit > nav, full > edit
    expect(editNames.size).toBeGreaterThan(navNames.size);
    expect(fullNames.size).toBeGreaterThan(editNames.size);
  });

  it("unknown future tool stays in full only (conservative default)", () => {
    const input = tools("smart_read", "some_unplanned_tool");
    const nav = filterToolsByProfile(input, "nav");
    const edit = filterToolsByProfile(input, "edit");
    const full = filterToolsByProfile(input, "full");
    expect(nav.map((t) => t.name)).not.toContain("some_unplanned_tool");
    expect(edit.map((t) => t.name)).not.toContain("some_unplanned_tool");
    expect(full.map((t) => t.name)).toContain("some_unplanned_tool");
  });
});

describe("parseProfileEnv", () => {
  it("undefined env → edit (default since v0.30.0, no warning)", () => {
    const warn = vi.fn();
    expect(parseProfileEnv(undefined, warn)).toBe("edit");
    expect(warn).not.toHaveBeenCalled();
  });

  it("empty string env → edit (default since v0.30.0, no warning)", () => {
    const warn = vi.fn();
    expect(parseProfileEnv("", warn)).toBe("edit");
    expect(warn).not.toHaveBeenCalled();
  });

  it("case-insensitive: NAV, Edit, FULL, MINIMAL all work", () => {
    expect(parseProfileEnv("NAV")).toBe("nav");
    expect(parseProfileEnv("Edit")).toBe("edit");
    expect(parseProfileEnv("FULL")).toBe("full");
    expect(parseProfileEnv("MINIMAL")).toBe("minimal");
  });

  it("unknown value falls back to edit AND emits a warning", () => {
    const warn = vi.fn();
    expect(parseProfileEnv("readonly", warn)).toBe("edit");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/TOKEN_PILOT_PROFILE="readonly"/);
  });

  it("whitespace is trimmed", () => {
    expect(parseProfileEnv("  nav  ")).toBe("nav");
  });

  it("PROFILE_NAMES constant lists all four profiles", () => {
    const names: readonly ToolProfile[] = PROFILE_NAMES;
    expect([...names].sort()).toEqual(["edit", "full", "minimal", "nav"]);
  });
});
