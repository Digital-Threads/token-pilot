/**
 * The server instruction is a short note on what token-pilot offers; when to
 * use each tool lives in that tool's own description, where the model reads
 * it at the moment it picks a tool.
 */
import { describe, it, expect } from "vitest";
import {
  MCP_INSTRUCTIONS,
  TOOL_DEFINITIONS,
} from "../../src/server/tool-definitions.ts";
import { childEnv } from "../../src/handlers/test-summary.ts";

describe("MCP_INSTRUCTIONS", () => {
  it("fits in five lines", () => {
    expect(MCP_INSTRUCTIONS.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("carries no shouted rules", () => {
    expect(MCP_INSTRUCTIONS).not.toMatch(/\b(ALWAYS|MANDATORY|NEVER|MUST|NOT)\b/);
  });

  it("names no tool, so no profile can advertise one it hides", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(MCP_INSTRUCTIONS, tool.name).not.toMatch(new RegExp(`\\b${tool.name}\\b`));
    }
  });
});

describe("read_for_edit description", () => {
  const desc = () => TOOL_DEFINITIONS.find((t) => t.name === "read_for_edit")!.description;

  it("is advice, not a rule: Read before Edit works too", () => {
    expect(desc()).not.toMatch(/\b(INSTEAD OF|MANDATORY|ALWAYS|MUST)\b/);
    expect(desc()).toMatch(/Read/);
  });
});

describe("test_summary description", () => {
  const desc = () => TOOL_DEFINITIONS.find((t) => t.name === "test_summary")!.description;

  it("says how a timeout kills the run on Windows, where there are no process groups", () => {
    expect(desc()).toMatch(/taskkill/);
  });

  it("names every variable the run forces, not just 'your terminal's environment'", () => {
    const forced = childEnv({});
    for (const [key, value] of Object.entries(forced)) expect(desc()).toContain(`${key}=${value}`);
    expect(desc()).not.toMatch(/with your terminal's environment minus/);
  });
});
