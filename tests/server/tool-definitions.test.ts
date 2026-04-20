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
    // edit-prep tools must NOT appear
    expect(txt).not.toContain("read_for_edit");
    expect(txt).not.toContain("read_symbols");
    expect(txt).not.toContain("read_diff");
    // audit tools must NOT appear
    expect(txt).not.toContain("code_audit");
    expect(txt).not.toContain("find_unused");
    expect(txt).not.toContain("test_summary");
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
});
