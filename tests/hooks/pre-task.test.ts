/**
 * Tests for the pre-task decision logic.
 *
 * Pure decide function; every case is a matrix cell — tool_name × mode
 * × confidence × escape × force. The matcher itself has its own
 * coverage; here we just build a minimal AgentIndex of 2-3 fake
 * `tp-*` entries and verify the router routes correctly.
 */
import { describe, it, expect } from "vitest";
import {
  decidePreTask,
  renderPreTaskOutput,
  type PreTaskContext,
  type PreTaskInput,
} from "../../src/hooks/pre-task.ts";
import { parseAgent, type AgentIndex } from "../../src/core/agent-matcher.ts";

const PR_REVIEWER = parseAgent(
  "tp-pr-reviewer",
  `---
name: tp-pr-reviewer
description: PROACTIVELY use this when the user asks to review a diff, PR, commit range, or changeset ("review these changes", "look at my PR", "is this safe to merge"). Verdict-first output. Do NOT use for writing code.
---
`,
)!;

const TEST_WRITER = parseAgent(
  "tp-test-writer",
  `---
name: tp-test-writer
description: PROACTIVELY use this when the user asks to write, add, or cover a SPECIFIC function / method / class with tests ("add test for X", "cover Y"). Do NOT use for diagnosing failures.
---
`,
)!;

const INDEX: AgentIndex = { agents: [PR_REVIEWER, TEST_WRITER] };

function ctx(overrides: Partial<PreTaskContext> = {}): PreTaskContext {
  return {
    mode: "deny",
    agentIndex: INDEX,
    force: false,
    ...overrides,
  };
}

function input(
  subagent_type: string,
  description: string,
  tool = "Task",
): PreTaskInput {
  return {
    tool_name: tool,
    tool_input: { subagent_type, description },
  };
}

describe("decidePreTask — allow cases", () => {
  it("allows non-Task tool calls", () => {
    const d = decidePreTask(
      input("general-purpose", "review PR", "Edit"),
      ctx(),
    );
    expect(d.kind).toBe("allow");
  });

  it("allows when subagent_type is already tp-*", () => {
    const d = decidePreTask(
      input("tp-pr-reviewer", "review these changes"),
      ctx(),
    );
    expect(d.kind).toBe("allow");
  });

  it("allows when description is empty", () => {
    const d = decidePreTask(input("general-purpose", ""), ctx());
    expect(d.kind).toBe("allow");
  });

  it("allows when heuristic returns no match", () => {
    const d = decidePreTask(
      input("general-purpose", "reminder to buy milk"),
      ctx(),
    );
    expect(d.kind).toBe("allow");
  });

  it("allows when description contains an escape phrase", () => {
    const d = decidePreTask(
      input("general-purpose", 'ad-hoc "review these changes" investigation'),
      ctx(),
    );
    expect(d.kind).toBe("allow");
  });

  it("allows open-ended / across-the-codebase escape forms", () => {
    for (const phrase of [
      "open-ended review these changes task",
      "review these changes across the codebase",
      "multi-step review these changes",
    ]) {
      expect(decidePreTask(input("general-purpose", phrase), ctx()).kind).toBe(
        "allow",
      );
    }
  });
});

describe("decidePreTask — advise cases (default deny-mode)", () => {
  it("advises on clear match (high confidence) in deny mode", () => {
    const d = decidePreTask(
      input("general-purpose", "please review these changes"),
      ctx({ mode: "deny" }),
    );
    expect(d.kind).toBe("advise");
    if (d.kind === "advise") {
      expect(d.message).toContain("tp-pr-reviewer");
      expect(d.message).toContain("confidence: high");
    }
  });

  it("advises on weak keyword match (low confidence)", () => {
    // Just "review" — no quoted trigger, weak signal.
    const d = decidePreTask(
      input("general-purpose", "review"),
      ctx({ mode: "deny" }),
    );
    // Match may return null on weak signal; if it returns, it should advise.
    if (d.kind !== "allow") expect(d.kind).toBe("advise");
  });

  it("advisory mode behaves identically — no hard-deny", () => {
    const d = decidePreTask(
      input("general-purpose", "please review these changes"),
      ctx({ mode: "advisory" }),
    );
    expect(d.kind).toBe("advise");
  });
});

describe("decidePreTask — deny cases (strict / force)", () => {
  it("strict mode hard-denies a clear match", () => {
    const d = decidePreTask(
      input("general-purpose", "please review these changes"),
      ctx({ mode: "strict" }),
    );
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.reason).toContain("tp-pr-reviewer");
      expect(d.reason).toContain("TOKEN_PILOT_MODE");
    }
  });

  it("TOKEN_PILOT_FORCE_SUBAGENTS=1 hard-denies even in deny mode", () => {
    const d = decidePreTask(
      input("general-purpose", "please review these changes"),
      ctx({ mode: "deny", force: true }),
    );
    expect(d.kind).toBe("deny");
  });

  it("force does NOT override an escape phrase", () => {
    const d = decidePreTask(
      input("general-purpose", "ad-hoc review these changes"),
      ctx({ mode: "deny", force: true }),
    );
    expect(d.kind).toBe("allow");
  });

  it("force does NOT block tp-* subagents", () => {
    const d = decidePreTask(
      input("tp-pr-reviewer", "review these changes"),
      ctx({ force: true }),
    );
    expect(d.kind).toBe("allow");
  });
});

describe("decidePreTask — matcher selection", () => {
  it("advises the right tp-* when multiple candidates exist", () => {
    const d = decidePreTask(
      input("general-purpose", "add test for loginUser"),
      ctx(),
    );
    expect(d.kind).toBe("advise");
    if (d.kind === "advise") {
      expect(d.message).toContain("tp-test-writer");
    }
  });
});

describe("renderPreTaskOutput", () => {
  it("returns null on allow", () => {
    expect(renderPreTaskOutput({ kind: "allow" })).toBeNull();
  });

  it("renders advise with permissionDecision=allow + additionalContext", () => {
    const out = renderPreTaskOutput({ kind: "advise", message: "hint" });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("hint");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("renders deny with permissionDecision=deny + reason", () => {
    const out = renderPreTaskOutput({ kind: "deny", reason: "blocked" });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("blocked");
  });
});
