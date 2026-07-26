/**
 * v0.50.1 — two defects in decidePreTask's guard clauses, both found by
 * tp-run agents auditing the v0.50.0 change.
 *
 * 1. The blank-description guard tested `description` rather than the
 *    haystack built one line above it. A dispatch with an empty
 *    description but a substantive prompt therefore returned early with
 *    soft advice, skipping escape detection, matching and blocking — the
 *    exact case prompt-matching was added to catch.
 *
 * 2. `description` was read with `?? ""` while `prompt` was type-guarded.
 *    A non-string description (say a number) survives `!description` and
 *    has no `.length`, so it reached the matcher as a non-string.
 */
import { describe, expect, it } from "vitest";
import { decidePreTask, type PreTaskInput } from "../../src/hooks/pre-task.ts";
import { parseAgent, type AgentIndex } from "../../src/core/agent-matcher.ts";

const index: AgentIndex = {
  agents: [
    parseAgent(
      "tp-pr-reviewer",
      `---
name: tp-pr-reviewer
description: PROACTIVELY use this when the user asks to review a diff, PR, commit range, or changeset ("review these changes", "look at my PR", "is this safe to merge").
---
`,
    )!,
  ],
};

const ctx = { mode: "deny" as const, agentIndex: index, force: false };

function task(tool_input: Record<string, unknown>): PreTaskInput {
  return { tool_name: "Task", tool_input: tool_input as never };
}

describe("decidePreTask guard clauses", () => {
  it("matches on the prompt when the description is empty", () => {
    const d = decidePreTask(
      task({
        subagent_type: "general-purpose",
        description: "",
        prompt: "review these changes before merge",
      }),
      ctx,
    );
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toContain("tp-pr-reviewer");
  });

  it("honours an escape phrase carried only by the prompt", () => {
    const d = decidePreTask(
      task({
        subagent_type: "general-purpose",
        description: "",
        prompt: "ad-hoc: review these changes however you like",
      }),
      ctx,
    );
    expect(d.kind).toBe("advise");
  });

  it("still advises when both description and prompt are empty", () => {
    const d = decidePreTask(
      task({ subagent_type: "general-purpose", description: "", prompt: "" }),
      ctx,
    );
    expect(d.kind).toBe("advise");
  });

  it("treats a non-string description as absent instead of matching on it", () => {
    const d = decidePreTask(
      task({ subagent_type: "general-purpose", description: 42 }),
      ctx,
    );
    expect(d.kind).toBe("advise");
  });

  it("survives a non-string prompt", () => {
    const d = decidePreTask(
      task({
        subagent_type: "general-purpose",
        description: "review these changes",
        prompt: { not: "a string" },
      }),
      ctx,
    );
    // The description alone still carries the match; the odd prompt is dropped.
    expect(d.kind).toBe("deny");
  });
});
