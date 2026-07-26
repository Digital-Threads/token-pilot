/**
 * v0.50.0 — routing to the cheap specialist actually enforces.
 *
 * Measured on a real session: dispatching `general-purpose` for a question
 * a tp-* agent covers costs 57,921 tokens against 18,677 for the same
 * question through `tp-run` — 3.1x, ~39k wasted per launch. Ten of eleven
 * launches that day went to general-purpose while the matcher was
 * correctly identifying a specialist every time.
 *
 * The reason was the decision tier, not the matcher: deny mode only ever
 * advised, and an advisory rides along as permissionDecision=allow, which
 * the model does not have to act on. Reads work precisely because they
 * come back denied. Two changes close the gap:
 *
 *   1. deny mode (the default) hard-blocks on a HIGH-confidence match.
 *   2. matching reads the prompt as well as the description, because
 *      descriptions are short ("Reuse review" scored 1 — low) while the
 *      prompt carries the real signal (the same task scores 3 — high).
 *
 * Escapes are unchanged: an escape phrase, or TOKEN_PILOT_MODE=advisory,
 * still gets you through with advice only.
 */
import { describe, expect, it } from "vitest";
import { decidePreTask, type PreTaskInput } from "../../src/hooks/pre-task.ts";
import { parseAgent, type AgentIndex } from "../../src/core/agent-matcher.ts";
import type { EnforcementMode } from "../../src/server/enforcement-mode.ts";

/** A catalog with one reviewer whose quoted trigger is unambiguous. */
const index: AgentIndex = {
  agents: [
    parseAgent(
      "tp-pr-reviewer",
      `---
name: tp-pr-reviewer
description: PROACTIVELY use this when the user asks to review a diff, PR, commit range, or changeset ("review these changes", "look at my PR", "is this safe to merge"). Verdict-first output.
---
`,
    )!,
  ],
};

function input(
  description: string,
  prompt?: string,
  subagentType = "general-purpose",
): PreTaskInput {
  return {
    tool_name: "Task",
    tool_input: { subagent_type: subagentType, description, prompt },
  };
}

function ctx(mode: EnforcementMode = "deny", force = false) {
  return { mode, agentIndex: index, force };
}

describe("pre-task routing enforcement", () => {
  it("hard-blocks a high-confidence match in the default deny mode", () => {
    const d = decidePreTask(input("review these changes"), ctx("deny"));
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.reason).toContain("tp-pr-reviewer");
      // The block has to say how to get past it, or it is just a wall.
      expect(d.reason).toContain("TOKEN_PILOT_MODE");
    }
  });

  it("still only advises on a low-confidence match", () => {
    // A single weak keyword should never cost someone their dispatch.
    const d = decidePreTask(input("review"), ctx("deny"));
    expect(d.kind).not.toBe("deny");
  });

  it("advisory mode never hard-blocks, however strong the match", () => {
    const d = decidePreTask(input("review these changes"), ctx("advisory"));
    expect(d.kind).toBe("advise");
  });

  it("an escape phrase still gets through with advice only", () => {
    const d = decidePreTask(input("ad-hoc review these changes"), ctx("deny"));
    expect(d.kind).toBe("advise");
  });

  it("leaves tp-* dispatches alone", () => {
    const d = decidePreTask(
      input("review these changes", undefined, "tp-pr-reviewer"),
      ctx("deny"),
    );
    expect(d.kind).toBe("allow");
  });

  // The description alone is usually a few words and scores low; the
  // prompt is where the real task lives. Without reading it, the
  // high-confidence tier almost never triggers on real dispatches.
  it("uses the prompt to reach high confidence when the description is thin", () => {
    const thin = decidePreTask(input("Reuse check"), ctx("deny"));
    const withPrompt = decidePreTask(
      input("Reuse check", "review these changes for duplication before merge"),
      ctx("deny"),
    );
    expect(thin.kind).not.toBe("deny");
    expect(withPrompt.kind).toBe("deny");
  });

  it("does not let a prompt escape phrase be ignored", () => {
    const d = decidePreTask(
      input("Reuse check", "ad-hoc: review these changes however you like"),
      ctx("deny"),
    );
    expect(d.kind).toBe("advise");
  });
});
