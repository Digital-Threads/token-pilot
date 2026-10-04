/**
 * 1.0.2 audit — the agent router blocked work it had no business blocking.
 *
 *  - One-word quoted triggers ("plan", "design", "scope") hard-blocked
 *    "execute plan task 3" and similar.
 *  - Other agent types (the built-in Plan, Explore, code-analyzer, …) were
 *    re-routed too; only general-purpose (or no type) is fair game.
 *  - Low-confidence suggestions were often wrong ("fix tests" →
 *    tp-commit-writer) and still cost the parent a message.
 *  - The subagent tool guide rode on the parent's context, where it is
 *    useless; the subagent never saw it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decidePreTask,
  renderPreTaskOutput,
  type PreTaskInput,
} from "../../src/hooks/pre-task.ts";
import {
  buildAgentIndexFromFiles,
  parseAgent,
} from "../../src/core/agent-matcher.ts";

const agentIndex = buildAgentIndexFromFiles(
  readdirSync("agents")
    .filter((f) => f.endsWith(".md"))
    .map((fileName) => ({
      fileName,
      body: readFileSync(`agents/${fileName}`, "utf-8"),
    })),
);

function dispatch(
  description: string,
  subagent_type?: string,
  prompt?: string,
): PreTaskInput {
  return {
    tool_name: "Agent",
    tool_input: { subagent_type, description, prompt },
  };
}

const deny = { mode: "deny" as const, agentIndex, force: false };

describe("agent router — what it may block", () => {
  it("hard-blocks general-purpose on a multi-word trigger phrase", () => {
    expect(decidePreTask(dispatch("review these changes", "general-purpose"), deny).kind).toBe("deny");
  });

  it("hard-blocks a dispatch with no agent type on the same phrase", () => {
    expect(decidePreTask(dispatch("review these changes"), deny).kind).toBe("deny");
  });

  it("never blocks on a one-word trigger", () => {
    for (const description of ["execute plan task 3", "design the cache layer", "scope the migration"]) {
      expect(decidePreTask(dispatch(description, "general-purpose"), deny).kind).not.toBe("deny");
    }
  });

  it("never re-routes another agent type, even on a phrase", () => {
    for (const type of ["Plan", "Explore", "code-analyzer"]) {
      const d = decidePreTask(dispatch("review these changes", type), deny);
      expect(d.kind).toBe("allow");
    }
  });

  it("says nothing on a low-confidence match", () => {
    const d = decidePreTask(dispatch("fix tests", "general-purpose"), deny);
    expect(d.kind).toBe("allow");
  });

  it("force and strict do not block without a trigger phrase either", () => {
    for (const ctx of [
      { ...deny, force: true },
      { ...deny, mode: "strict" as const },
    ]) {
      expect(decidePreTask(dispatch("execute plan task 3", "general-purpose"), ctx).kind).not.toBe("deny");
    }
  });
});

describe("agent templates", () => {
  it("carry no one-word quoted trigger", () => {
    for (const file of readdirSync("templates/agents").filter((f) => f.startsWith("tp-"))) {
      const agent = parseAgent(file, readFileSync(`templates/agents/${file}`, "utf-8"));
      for (const trigger of agent?.quotedTriggers ?? []) {
        expect(trigger, `${file}: "${trigger}"`).toContain(" ");
      }
    }
  });
});

describe("subagent tool guide", () => {
  it("is not sent to the parent by the command hook", () => {
    const d = decidePreTask(dispatch("reminder to buy milk", "general-purpose"), deny);
    expect(renderPreTaskOutput(d)).toBeNull();
  });

  it("is not part of a routing suggestion either", () => {
    const d = decidePreTask(dispatch("review these changes", "general-purpose"), deny);
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).not.toContain("smart_read");
  });
});
