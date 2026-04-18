/**
 * TP-q33(a) — post-Task budget enforcement.
 *
 * Today tp-* agents get a `Response budget: ~N tokens` line in their
 * preamble but nothing enforces it. When a subagent returns 1200 tokens
 * for an 800-token budget, the over-run is invisible. This hook fires on
 * PostToolUse:Task, reads the called subagent's frontmatter budget,
 * counts tokens in the response body, and logs anything > 110 % of budget
 * to `.token-pilot/over-budget.log` for later review via stats.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgentBudget,
  extractSubagentTokens,
  decideBudgetAdvice,
  appendOverBudgetLog,
  OVER_BUDGET_LOG,
  OVER_BUDGET_TOLERANCE,
} from "../../src/hooks/post-task.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-post-task-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("parseAgentBudget", () => {
  it("reads the budget line from a tp-* agent body", () => {
    const body = `---
name: tp-run
---

Role: workhorse.

Response budget: ~800 tokens.

1. step one.`;
    expect(parseAgentBudget(body)).toBe(800);
  });

  it("handles missing tilde and different whitespace", () => {
    expect(parseAgentBudget("Response budget: 600 tokens.")).toBe(600);
    expect(parseAgentBudget("Response budget:~400 tokens")).toBe(400);
  });

  it("returns null when absent / malformed", () => {
    expect(parseAgentBudget("no budget here")).toBeNull();
    expect(parseAgentBudget("Response budget: lots of tokens")).toBeNull();
  });
});

describe("extractSubagentTokens", () => {
  it("measures the Task tool_response body", () => {
    const hookInput = {
      tool_name: "Task",
      tool_input: { subagent_type: "tp-run" },
      tool_response: {
        content: [{ type: "text", text: "a".repeat(4000) }],
      },
    };
    // ~1000 tokens (chars/4 heuristic)
    expect(extractSubagentTokens(hookInput)).toBe(1000);
  });

  it("sums multiple content blocks", () => {
    const hookInput = {
      tool_name: "Task",
      tool_response: {
        content: [
          { type: "text", text: "a".repeat(400) },
          { type: "text", text: "b".repeat(400) },
        ],
      },
    };
    // (400 + 400) / 4
    expect(extractSubagentTokens(hookInput)).toBe(200);
  });

  it("returns null for non-Task tools", () => {
    expect(
      extractSubagentTokens({ tool_name: "Bash", tool_response: {} }),
    ).toBeNull();
  });

  it("returns null when response shape is unexpected", () => {
    expect(
      extractSubagentTokens({ tool_name: "Task", tool_response: null }),
    ).toBeNull();
  });
});

describe("decideBudgetAdvice", () => {
  it("stays silent when within budget + tolerance", () => {
    const r = decideBudgetAdvice({
      agentName: "tp-run",
      budget: 800,
      actualTokens: 870,
    });
    expect(r.overBudget).toBe(false);
    expect(r.message).toBeNull();
  });

  it("flags when beyond tolerance", () => {
    const r = decideBudgetAdvice({
      agentName: "tp-run",
      budget: 800,
      actualTokens: 1200,
    });
    expect(r.overBudget).toBe(true);
    expect(r.overByRatio).toBeCloseTo(0.5, 2); // 1200 / 800 - 1
    expect(r.message).toMatch(/tp-run/);
    expect(r.message).toMatch(/50%/);
  });

  it("uses OVER_BUDGET_TOLERANCE as the threshold", () => {
    const at = Math.floor(800 * (1 + OVER_BUDGET_TOLERANCE));
    const under = decideBudgetAdvice({
      agentName: "tp-x",
      budget: 800,
      actualTokens: at,
    });
    expect(under.overBudget).toBe(false);
    const over = decideBudgetAdvice({
      agentName: "tp-x",
      budget: 800,
      actualTokens: at + 1,
    });
    expect(over.overBudget).toBe(true);
  });

  it("passes through null budget (no frontmatter budget found)", () => {
    const r = decideBudgetAdvice({
      agentName: "tp-x",
      budget: null,
      actualTokens: 999,
    });
    expect(r.overBudget).toBe(false);
    expect(r.message).toBeNull();
  });
});

describe("appendOverBudgetLog", () => {
  it("creates .token-pilot/over-budget.log with a JSONL entry", async () => {
    await appendOverBudgetLog(tempDir, {
      ts: 1_700_000_000_000,
      agent: "tp-run",
      budget: 800,
      actualTokens: 1200,
      overByRatio: 0.5,
    });
    const logPath = join(tempDir, ".token-pilot", OVER_BUDGET_LOG);
    const raw = await readFile(logPath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toMatchObject({
      agent: "tp-run",
      budget: 800,
      actualTokens: 1200,
      overByRatio: 0.5,
    });
  });

  it("appends additional entries on subsequent calls", async () => {
    await appendOverBudgetLog(tempDir, {
      ts: 1,
      agent: "a",
      budget: 100,
      actualTokens: 200,
      overByRatio: 1,
    });
    await appendOverBudgetLog(tempDir, {
      ts: 2,
      agent: "b",
      budget: 100,
      actualTokens: 300,
      overByRatio: 2,
    });
    const raw = await readFile(
      join(tempDir, ".token-pilot", OVER_BUDGET_LOG),
      "utf-8",
    );
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).agent).toBe("a");
    expect(JSON.parse(lines[1]).agent).toBe("b");
  });

  it("never throws on filesystem failure", async () => {
    // pass a path where mkdir will fail silently — function must swallow
    await expect(
      appendOverBudgetLog("/nonexistent/root-without-perms/xyz", {
        ts: 1,
        agent: "x",
        budget: 100,
        actualTokens: 200,
        overByRatio: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
