/**
 * v0.31.0 Task-telemetry extension of processPostTask.
 *
 * The existing test file covers the pure budget helpers. This file
 * covers the new side effect: every Task PostToolUse hook invocation
 * appends one `event: "task"` record to hook-events.jsonl with
 * subagent_type, matched_tp_agent (heuristic), budget, overBudget.
 *
 * Integration-style: real temp projectRoot + real agents dir (fixture)
 * so we exercise the cache + matcher wiring end-to-end. That's the
 * smallest test that catches wiring regressions — pure-unit tests on
 * the piece-parts already pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processPostTask,
  _resetAgentIndexCache,
} from "../../src/hooks/post-task.ts";
import { loadEvents } from "../../src/core/event-log.ts";

let projectRoot: string;
let homeDir: string;
let agentsDir: string;

const PR_REVIEWER_BODY = `---
name: tp-pr-reviewer
description: PROACTIVELY use this when the user asks to review a diff, PR, commit range, or changeset ("review these changes", "look at my PR", "is this safe to merge"). Verdict-first output with Critical / Important findings. Do NOT use for writing code or planning.
---
Response budget: ~1000 tokens.
`;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "tp-telem-root-"));
  homeDir = await mkdtemp(join(tmpdir(), "tp-telem-home-"));
  agentsDir = join(projectRoot, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, "tp-pr-reviewer.md"),
    PR_REVIEWER_BODY,
    "utf-8",
  );
  // Ensure the cached index reflects THIS fixture's dir — otherwise
  // the module cache from a previous test file bleeds in.
  _resetAgentIndexCache();
  // Force the next getAgentIndex() call to use our fixture dir by
  // seeding it directly.
  const { buildAgentIndex } = await import("../../src/core/agent-matcher.ts");
  const idx = await buildAgentIndex(agentsDir);
  // Monkey-reach into the module: there's no public setter, but
  // processPostTask calls getAgentIndex(defaultAgentsDir()) which resolves
  // relative to the dist path. For the test to hit OUR fixture we stub
  // via resetting then prewarming getAgentIndex with the fixture dir.
  const { getAgentIndex } = await import("../../src/hooks/post-task.ts");
  // Prewarm cache with our fixture dir path
  await getAgentIndex(agentsDir);
  // Quick sanity check
  expect(idx.agents.length).toBe(1);
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  _resetAgentIndexCache();
});

function input(
  subagent_type: string,
  description: string,
  responseText = "some response body",
) {
  return {
    tool_name: "Task",
    tool_input: { subagent_type, description },
    tool_response: { content: [{ type: "text", text: responseText }] },
    session_id: "sess-123",
    agent_type: null as unknown as string | undefined,
    agent_id: null as unknown as string | undefined,
  };
}

describe("processPostTask telemetry", () => {
  it("writes a 'task' event for a general-purpose call with a matching description", async () => {
    await processPostTask(
      projectRoot,
      homeDir,
      input("general-purpose", "please review these changes in my PR"),
    );
    const events = await loadEvents(projectRoot);
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.event).toBe("task");
    expect(e.subagent_type).toBe("general-purpose");
    expect(e.matched_tp_agent).toBe("tp-pr-reviewer");
    expect(e.match_confidence).toBe("high");
    expect(e.session_id).toBe("sess-123");
  });

  it("writes a 'task' event for a tp-* call with matched_tp_agent=null", async () => {
    await processPostTask(
      projectRoot,
      homeDir,
      input("tp-pr-reviewer", "review PR"),
    );
    const events = await loadEvents(projectRoot);
    expect(events.length).toBe(1);
    expect(events[0].subagent_type).toBe("tp-pr-reviewer");
    expect(events[0].matched_tp_agent).toBeNull();
  });

  it("records matched_tp_agent=null when no heuristic hit", async () => {
    await processPostTask(
      projectRoot,
      homeDir,
      input("general-purpose", "reminder to buy milk"),
    );
    const events = await loadEvents(projectRoot);
    expect(events.length).toBe(1);
    expect(events[0].matched_tp_agent).toBeNull();
    expect(events[0].match_confidence).toBeUndefined();
  });

  it("skips non-Task tool calls (no event written)", async () => {
    await processPostTask(projectRoot, homeDir, {
      tool_name: "Bash",
      tool_input: { subagent_type: "tp-pr-reviewer" as any },
    } as any);
    const events = await loadEvents(projectRoot);
    expect(events).toEqual([]);
  });
});
