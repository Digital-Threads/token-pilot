/**
 * Tests for the v0.38.0 fleet workflow lifecycle.
 *
 * Filesystem helpers use a tmp project root. Pure functions
 * (computeWorkflowStatus, isWorkflowNearBudget, makeWorkflowId,
 * activeWorkflowId, formatters) are driven directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeWorkflowId,
  activeWorkflowId,
  startWorkflow,
  loadWorkflow,
  endWorkflow,
  listWorkflows,
  computeWorkflowStatus,
  isWorkflowNearBudget,
  formatWorkflowStatus,
  formatWorkflowList,
  type WorkflowEnvelope,
} from "../../src/core/workflow.ts";
import type { HookEvent } from "../../src/core/event-log.ts";

describe("makeWorkflowId", () => {
  it("builds a deterministic id from now + suffix", () => {
    expect(makeWorkflowId(0, "abcd")).toBe("wf-0-abcd");
    expect(makeWorkflowId(1_000_000, "zz")).toBe(
      `wf-${(1_000_000).toString(36)}-zz`,
    );
  });
});

describe("activeWorkflowId", () => {
  it("prefers TOKEN_PILOT_WORKFLOW_ID", () => {
    expect(
      activeWorkflowId({
        TOKEN_PILOT_WORKFLOW_ID: "wf-a",
        CLAUDE_CODE_WORKFLOW_ID: "wf-b",
      } as NodeJS.ProcessEnv),
    ).toBe("wf-a");
  });
  it("falls back to Claude Code names", () => {
    expect(
      activeWorkflowId({
        CLAUDE_CODE_WORKFLOW_ID: "wf-b",
      } as NodeJS.ProcessEnv),
    ).toBe("wf-b");
  });
  it("returns null when none set", () => {
    expect(activeWorkflowId({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("computeWorkflowStatus", () => {
  const envelope: WorkflowEnvelope = {
    workflow_id: "wf-x",
    started_at: 1000,
    ended_at: null,
    goal: "review sprint",
    budget_tokens: 10_000,
    max_parallel: 8,
  };

  function ev(over: Partial<HookEvent>): HookEvent {
    return {
      ts: 1,
      session_id: "s",
      agent_type: null,
      agent_id: null,
      event: "task",
      file: "",
      lines: 0,
      estTokens: 0,
      summaryTokens: 0,
      savedTokens: 0,
      ...over,
    };
  }

  it("sums estTokens of tagged task events and counts over-budget workers", () => {
    const events: HookEvent[] = [
      ev({ workflow_id: "wf-x", estTokens: 3000 }),
      ev({ workflow_id: "wf-x", estTokens: 2000, overBudget: true }),
      ev({ workflow_id: "wf-other", estTokens: 9999 }), // ignored
      ev({ workflow_id: "wf-x", event: "denied", estTokens: 500 }), // not a task
    ];
    const st = computeWorkflowStatus(envelope, events);
    expect(st.used_tokens).toBe(5000);
    expect(st.task_count).toBe(2);
    expect(st.over_budget_workers).toBe(1);
    expect(st.pct).toBe(50);
    expect(st.event_count).toBe(3); // 3 tagged wf-x (incl the denied one)
    expect(st.ended).toBe(false);
  });

  it("pct is null with no budget", () => {
    const st = computeWorkflowStatus(
      { ...envelope, budget_tokens: null },
      [ev({ workflow_id: "wf-x", estTokens: 1000 })],
    );
    expect(st.pct).toBeNull();
  });
});

describe("isWorkflowNearBudget", () => {
  const base = {
    workflow_id: "wf",
    goal: "g",
    used_tokens: 0,
    pct: 0,
    event_count: 0,
    task_count: 0,
    over_budget_workers: 0,
    ended: false,
  };
  it("true at/over 90% by default", () => {
    expect(
      isWorkflowNearBudget({ ...base, budget_tokens: 1000, used_tokens: 900 }),
    ).toBe(true);
    expect(
      isWorkflowNearBudget({ ...base, budget_tokens: 1000, used_tokens: 1200 }),
    ).toBe(true);
  });
  it("false below threshold", () => {
    expect(
      isWorkflowNearBudget({ ...base, budget_tokens: 1000, used_tokens: 500 }),
    ).toBe(false);
  });
  it("false when no budget", () => {
    expect(
      isWorkflowNearBudget({ ...base, budget_tokens: null, used_tokens: 999 }),
    ).toBe(false);
  });
});

describe("filesystem lifecycle", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tp-wf-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("start writes an envelope that load can read back", async () => {
    const env = await startWorkflow({
      projectRoot: root,
      goal: "do the thing",
      budgetTokens: 5000,
      now: 42,
      idSuffix: "test",
    });
    expect(env.workflow_id).toBe("wf-16-test"); // 42 in base36 = "16"
    const loaded = await loadWorkflow(root, env.workflow_id);
    expect(loaded?.goal).toBe("do the thing");
    expect(loaded?.budget_tokens).toBe(5000);
    expect(loaded?.ended_at).toBeNull();
    // envelope persisted on disk as JSON
    const raw = await readFile(
      join(root, ".token-pilot", "workflows", `${env.workflow_id}.json`),
      "utf-8",
    );
    expect(JSON.parse(raw).workflow_id).toBe(env.workflow_id);
  });

  it("end stamps ended_at", async () => {
    const env = await startWorkflow({
      projectRoot: root,
      goal: "g",
      now: 1,
      idSuffix: "x",
    });
    const ended = await endWorkflow(root, env.workflow_id, 9999);
    expect(ended?.ended_at).toBe(9999);
    const reloaded = await loadWorkflow(root, env.workflow_id);
    expect(reloaded?.ended_at).toBe(9999);
  });

  it("end returns null for unknown id", async () => {
    expect(await endWorkflow(root, "wf-nope", 1)).toBeNull();
  });

  it("list returns newest first", async () => {
    await startWorkflow({ projectRoot: root, goal: "a", now: 1, idSuffix: "a" });
    await startWorkflow({ projectRoot: root, goal: "b", now: 2, idSuffix: "b" });
    const all = await listWorkflows(root);
    expect(all.map((w) => w.goal)).toEqual(["b", "a"]);
  });

  it("list is empty when no workflows", async () => {
    expect(await listWorkflows(root)).toEqual([]);
  });
});

describe("formatters", () => {
  it("formatWorkflowStatus renders budget + tasks", () => {
    const out = formatWorkflowStatus({
      workflow_id: "wf-1",
      goal: "review",
      budget_tokens: 2_000_000,
      used_tokens: 1_400_000,
      pct: 70,
      event_count: 40,
      task_count: 17,
      over_budget_workers: 3,
      ended: false,
    });
    expect(out).toContain("wf-1");
    expect(out).toContain("2.0M ceiling");
    expect(out).toContain("1.4M used (70%)");
    expect(out).toContain("17 dispatched · 3 over-budget");
  });

  it("formatWorkflowList handles empty", () => {
    expect(formatWorkflowList([])).toMatch(/No workflows/);
  });
});
