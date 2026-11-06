/**
 * v0.31.0 Task telemetry in processPostTask: every Task PostToolUse hook
 * invocation appends one `event: "task"` record to hook-events.jsonl with
 * subagent_type, budget and overBudget. token-pilot no longer routes
 * dispatches to tp-* agents, so matched_tp_agent is always null.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPostTask } from "../../src/hooks/post-task.ts";
import { loadEvents } from "../../src/core/event-log.ts";

let projectRoot: string;
let homeDir: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "tp-telem-root-"));
  homeDir = await mkdtemp(join(tmpdir(), "tp-telem-home-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
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
  it("writes a 'task' event for a general-purpose call, with no routing match", async () => {
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
    expect(e.matched_tp_agent).toBeNull();
    expect(e.match_confidence).toBeUndefined();
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

  it("skips non-Task tool calls (no event written)", async () => {
    await processPostTask(projectRoot, homeDir, {
      tool_name: "Bash",
      tool_input: { subagent_type: "tp-pr-reviewer" as any },
    } as any);
    const events = await loadEvents(projectRoot);
    expect(events).toEqual([]);
  });
});
