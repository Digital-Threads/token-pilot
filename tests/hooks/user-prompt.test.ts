/**
 * Tests for the UserPromptSubmit per-turn reinforcement hook builder.
 *
 * Pure functions. We cover:
 *   - disabled / bypass → null (caller emits nothing)
 *   - enabled → the minimal anchor (the per-turn floor)
 *   - output envelope shape (additionalContext, never a block decision)
 */
import { describe, expect, it } from "vitest";
import {
  buildPromptReminder,
  formatPromptReminderOutput,
  MINIMAL_ANCHOR,
} from "../../src/hooks/user-prompt.ts";

describe("buildPromptReminder", () => {
  it("returns null when disabled", () => {
    expect(buildPromptReminder(false, false)).toBeNull();
  });

  it("returns null when bypassed", () => {
    expect(buildPromptReminder(true, true)).toBeNull();
  });

  it("emits the minimal anchor when enabled and not bypassed", () => {
    expect(buildPromptReminder(true, false)).toBe(MINIMAL_ANCHOR);
  });
});

describe("formatPromptReminderOutput", () => {
  it("wraps the message as UserPromptSubmit additionalContext, never a block", () => {
    const out = JSON.parse(formatPromptReminderOutput("hello"));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "hello",
      },
    });
    expect(out.decision).toBeUndefined();
  });
});
