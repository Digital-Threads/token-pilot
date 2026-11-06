/**
 * UserPromptSubmit: Claude Code gets nothing per prompt — each tool's own
 * description says when to use it, and a line repeated on every turn only
 * competes with the user's request. Codex, which reads code through the
 * shell, keeps its one-line anchor.
 */
import { describe, expect, it } from "vitest";
import {
  buildPromptReminder,
  formatPromptReminderOutput,
} from "../../src/hooks/user-prompt.ts";

describe("buildPromptReminder", () => {
  it("sends Claude Code nothing", () => {
    expect(buildPromptReminder(true, false)).toBeNull();
    expect(buildPromptReminder(true, false, "claude-code")).toBeNull();
  });

  it("sends Codex its anchor", () => {
    expect(buildPromptReminder(true, false, "codex")).toContain("smart_read");
  });

  it("sends Codex nothing when disabled or bypassed", () => {
    expect(buildPromptReminder(false, false, "codex")).toBeNull();
    expect(buildPromptReminder(true, true, "codex")).toBeNull();
  });
});

describe("formatPromptReminderOutput", () => {
  it("wraps the message as UserPromptSubmit additionalContext, never a block", () => {
    const out = JSON.parse(formatPromptReminderOutput("hi"));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toBe("hi");
    expect(out).not.toHaveProperty("decision");
  });
});
