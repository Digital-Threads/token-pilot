/**
 * v0.30.0 — getMcpInstructions profile-specific instructions.
 *
 * Verifies:
 *  - Each profile returns instructions that only mention its own tools.
 *  - Profiles are shorter / longer as expected (minimal < nav < edit <= full).
 *  - The deprecated MCP_INSTRUCTIONS alias still resolves to full instructions.
 */
import { describe, it, expect } from "vitest";
import {
  getMcpInstructions,
  MCP_INSTRUCTIONS,
} from "../../src/server/tool-definitions.ts";

describe("getMcpInstructions", () => {
  it("minimal instructions mention only the 5 core tools", () => {
    const txt = getMcpInstructions("minimal");
    expect(txt).toContain("smart_read");
    expect(txt).toContain("read_symbol");
    expect(txt).toContain("find_usages");
    expect(txt).toContain("smart_diff");
    expect(txt).toContain("smart_log");
    // edit-only tools should NOT appear in minimal instructions
    expect(txt).not.toContain("read_for_edit");
    expect(txt).not.toContain("read_symbols");
    expect(txt).not.toContain("read_diff");
    // audit tools should NOT appear
    expect(txt).not.toContain("code_audit");
    expect(txt).not.toContain("find_unused");
  });

  it("nav instructions mention nav tools but not edit/audit tools", () => {
    const txt = getMcpInstructions("nav");
    expect(txt).toContain("smart_read");
    expect(txt).toContain("find_usages");
    expect(txt).toContain("explore_area");
    expect(txt).toContain("smart_log");
    // v0.30.0: read_section is nav-class (read-only section extraction for
    // YAML/JSON/CSV/Markdown) — must appear in nav instructions
    expect(txt).toContain("read_section");
    // edit-prep tools must NOT appear
    expect(txt).not.toContain("read_for_edit");
    expect(txt).not.toContain("read_symbols");
    expect(txt).not.toContain("read_diff");
    // audit tools must NOT appear
    expect(txt).not.toContain("code_audit");
    expect(txt).not.toContain("find_unused");
    expect(txt).not.toContain("test_summary");
  });

  it("nav and edit fallback lines do not direct to Read/Grep for JSON/YAML/Markdown (v0.30.0)", () => {
    // read_section now handles YAML/JSON/CSV/Markdown — the fallback must not
    // contradict the decision rules by listing these types as "use Read/Grep".
    for (const profile of ["nav", "edit", "full"] as const) {
      const txt = getMcpInstructions(profile);
      // The fallback line should not re-direct the agent to use Read for
      // file types that read_section handles.
      expect(txt, `profile=${profile}`).not.toMatch(
        /USE Read\/Grep ONLY for:.*(?:JSON|YAML|Markdown|markdown|yaml|json)/,
      );
    }
  });

  it("edit instructions mention edit tools but not audit tools", () => {
    const txt = getMcpInstructions("edit");
    expect(txt).toContain("smart_read");
    expect(txt).toContain("read_for_edit");
    expect(txt).toContain("read_symbols");
    expect(txt).toContain("read_diff");
    // audit tools not in edit profile
    expect(txt).not.toContain("code_audit");
    expect(txt).not.toContain("find_unused");
    expect(txt).not.toContain("test_summary");
  });

  it("full instructions mention all tool categories", () => {
    const txt = getMcpInstructions("full");
    expect(txt).toContain("smart_read");
    expect(txt).toContain("read_for_edit");
    expect(txt).toContain("code_audit");
    expect(txt).toContain("find_unused");
    expect(txt).toContain("test_summary");
  });

  it("instructions grow from minimal → nav → edit → full", () => {
    const sizes = (["minimal", "nav", "edit", "full"] as const).map(
      (p) => getMcpInstructions(p).length,
    );
    // Each profile's instructions must be larger than the previous
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `profile[${i}] > profile[${i - 1}]`).toBeGreaterThan(
        sizes[i - 1],
      );
    }
  });

  it("deprecated MCP_INSTRUCTIONS alias equals full instructions", () => {
    expect(MCP_INSTRUCTIONS).toBe(getMcpInstructions("full"));
  });

  // Tool-audit telemetry (2026-04-24) showed a huge gap between Codex
  // (read_for_edit = 33% of all calls) and Claude (0.3%). Claude was reading
  // via smart_read and diffing the snippet into Edit — which often mismatched.
  // Both edit and full profiles must now carry an explicit MANDATORY block
  // that forces read_for_edit before any Edit on an existing file.
  for (const profile of ["edit", "full"] as const) {
    it(`${profile} profile contains MANDATORY read_for_edit-before-Edit rule`, () => {
      const txt = getMcpInstructions(profile);
      expect(txt).toContain("MANDATORY EDIT SAFETY");
      expect(txt).toMatch(/FIRST call read_for_edit/);
      // Explicit anti-pattern callout — never build old_string from smart_read
      expect(txt).toMatch(/NEVER build Edit's old_string from a smart_read/);
      // The numbered rule for read_for_edit is now marked MANDATORY, not optional
      expect(txt).toMatch(/read_for_edit — MANDATORY, not optional/);
      // Workflow line reinforces the flow
      expect(txt).toContain(
        "Edit (mandatory): smart_read (to pick target) → read_for_edit → Edit → read_diff",
      );
    });
  }

  it("nav and minimal profiles must NOT carry the edit-safety rule (no edit tools there)", () => {
    for (const profile of ["nav", "minimal"] as const) {
      const txt = getMcpInstructions(profile);
      expect(txt, `profile=${profile}`).not.toContain("MANDATORY EDIT SAFETY");
      expect(txt, `profile=${profile}`).not.toContain("read_for_edit");
    }
  });
});
