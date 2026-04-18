/**
 * TP-jzh — Bash output advisor tests.
 */
import { describe, it, expect } from "vitest";
import {
  decidePostBashAdvice,
  renderPostBashHookOutput,
  LARGE_OUTPUT_THRESHOLD_CHARS,
} from "../../src/hooks/post-bash.ts";

describe("decidePostBashAdvice", () => {
  it("stays silent when tool_name is not Bash", () => {
    const huge = "x".repeat(LARGE_OUTPUT_THRESHOLD_CHARS * 2);
    const r = decidePostBashAdvice({
      tool_name: "Read",
      tool_response: { stdout: huge },
    });
    expect(r.additionalContext).toBeNull();
  });

  it("stays silent when output is under the threshold", () => {
    const r = decidePostBashAdvice({
      tool_name: "Bash",
      tool_response: { stdout: "small output" },
    });
    expect(r.additionalContext).toBeNull();
    expect(r.outputChars).toBe(12);
  });

  it("emits advice with mcp__token-pilot__test_summary mention when output is large", () => {
    const huge = "line\n".repeat(3000); // ~15000 chars
    const r = decidePostBashAdvice({
      tool_name: "Bash",
      tool_response: { stdout: huge },
    });
    expect(r.additionalContext).not.toBeNull();
    expect(r.additionalContext!).toMatch(/Bash output was large/);
    expect(r.additionalContext!).toContain("mcp__token-pilot__test_summary");
    expect(r.outputChars).toBeGreaterThanOrEqual(LARGE_OUTPUT_THRESHOLD_CHARS);
  });

  it("handles string tool_response (non-object)", () => {
    const huge = "a".repeat(LARGE_OUTPUT_THRESHOLD_CHARS + 100);
    const r = decidePostBashAdvice({
      tool_name: "Bash",
      tool_response: huge,
    });
    expect(r.additionalContext).not.toBeNull();
  });

  it("handles missing tool_response field", () => {
    const r = decidePostBashAdvice({ tool_name: "Bash" });
    expect(r.additionalContext).toBeNull();
    expect(r.outputChars).toBe(0);
  });

  it("respects a custom threshold argument", () => {
    const r = decidePostBashAdvice(
      { tool_name: "Bash", tool_response: { stdout: "0123456789" } },
      5,
    );
    expect(r.additionalContext).not.toBeNull();
  });

  it("reads stdout, output, or content fields of tool_response", () => {
    const huge = "x".repeat(LARGE_OUTPUT_THRESHOLD_CHARS + 1);
    for (const key of ["stdout", "output", "content"] as const) {
      const r = decidePostBashAdvice({
        tool_name: "Bash",
        tool_response: { [key]: huge },
      });
      expect(r.additionalContext, `failed on key=${key}`).not.toBeNull();
    }
  });
});

describe("renderPostBashHookOutput", () => {
  it("returns null when there is no advice", () => {
    expect(
      renderPostBashHookOutput({ additionalContext: null, outputChars: 0 }),
    ).toBeNull();
  });

  it("returns a PostToolUse hookSpecificOutput JSON when advice is present", () => {
    const rendered = renderPostBashHookOutput({
      additionalContext: "do better",
      outputChars: 9001,
    });
    expect(rendered).not.toBeNull();
    const parsed = JSON.parse(rendered!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("do better");
  });
});
