/**
 * Tests for v0.40.0 SubagentStop task-completion capture.
 *
 * buildSubagentTaskEvent is pure (token read injectable);
 * tokensFromTranscript is exercised against a tmp JSONL file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSubagentTaskEvent,
  tokensFromTranscript,
  finalResponseTokens,
  decideSubagentFeedback,
  renderSubagentFeedback,
  checkSubagentBudget,
  type SubagentStopInput,
} from "../../src/hooks/subagent-stop.ts";

describe("buildSubagentTaskEvent", () => {
  it("builds a task event from agent_type with injected tokens", () => {
    const input: SubagentStopInput = {
      hook_event_name: "SubagentStop",
      agent_id: "a123",
      agent_type: "tp-pr-reviewer",
      session_id: "s1",
      agent_transcript_path: "/nope",
    };
    const ev = buildSubagentTaskEvent(input, 1000, 4242);
    expect(ev).not.toBeNull();
    expect(ev!.event).toBe("task");
    expect(ev!.subagent_type).toBe("tp-pr-reviewer");
    expect(ev!.agent_id).toBe("a123");
    expect(ev!.estTokens).toBe(4242);
    expect(ev!.matched_tp_agent).toBeNull();
    expect(ev!.code).toBe("subagent_stop");
    expect(ev!.ts).toBe(1000);
  });

  it("captures general-purpose dispatches (the adoption miss signal)", () => {
    const ev = buildSubagentTaskEvent(
      { agent_type: "general-purpose", agent_id: "x" },
      5,
      0,
    );
    expect(ev!.subagent_type).toBe("general-purpose");
    expect(ev!.estTokens).toBe(0);
  });

  it("returns null when agent_type is absent (nothing to record)", () => {
    expect(buildSubagentTaskEvent({ agent_id: "x" }, 1, 0)).toBeNull();
    expect(buildSubagentTaskEvent({}, 1, 0)).toBeNull();
  });

  it("carries parent_agent_id when present", () => {
    const ev = buildSubagentTaskEvent(
      { agent_type: "tp-debugger", parent_agent_id: "p1" },
      1,
      0,
    );
    expect(ev!.parent_agent_id).toBe("p1");
  });

  it("carries parent_session_id when present (subagent savings rollup)", () => {
    const ev = buildSubagentTaskEvent(
      {
        agent_type: "tp-debugger",
        session_id: "agent-sess",
        parent_session_id: "main-sess",
      },
      1,
      0,
    );
    expect(ev!.session_id).toBe("agent-sess");
    expect(ev!.parent_session_id).toBe("main-sess");
  });

  it("omits parent_session_id when absent (older CC / main thread)", () => {
    const ev = buildSubagentTaskEvent({ agent_type: "tp-debugger" }, 1, 0);
    expect(ev!.parent_session_id).toBeUndefined();
  });
});

describe("tokensFromTranscript", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns 0 for missing path", () => {
    expect(tokensFromTranscript(undefined)).toBe(0);
    expect(tokensFromTranscript("/does/not/exist.jsonl")).toBe(0);
  });

  it("sums usage.output_tokens across assistant messages", async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-transcript-"));
    const p = join(dir, "t.jsonl");
    await writeFile(
      p,
      [
        JSON.stringify({ message: { usage: { output_tokens: 100 } } }),
        JSON.stringify({ type: "user" }),
        JSON.stringify({ message: { usage: { output_tokens: 250 } } }),
        "not json",
        "",
      ].join("\n"),
    );
    expect(tokensFromTranscript(p)).toBe(350);
  });

  it("falls back to last cumulative total_tokens when no output_tokens", async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-transcript-"));
    const p = join(dir, "t.jsonl");
    await writeFile(
      p,
      [
        JSON.stringify({ usage: { total_tokens: 500 } }),
        JSON.stringify({ usage: { total_tokens: 1200 } }),
      ].join("\n"),
    );
    expect(tokensFromTranscript(p)).toBe(1200);
  });
});

describe("decideSubagentFeedback (v0.41.0)", () => {
  const input: SubagentStopInput = { agent_type: "general-purpose", agent_id: "x" };

  it("warns when an active workflow is at/over 90% of its ceiling", () => {
    const msg = decideSubagentFeedback(input, {
      workflow: {
        workflow_id: "wf-1",
        budget_tokens: 1000,
        used_tokens: 950,
        pct: 95,
      },
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("wf-1");
    expect(msg).toContain("95%");
    expect(msg).toMatch(/wind down/i);
  });

  it("stays silent below 90%", () => {
    expect(
      decideSubagentFeedback(input, {
        workflow: {
          workflow_id: "wf-1",
          budget_tokens: 1000,
          used_tokens: 500,
          pct: 50,
        },
      }),
    ).toBeNull();
  });

  it("stays silent with no workflow / no budget", () => {
    expect(decideSubagentFeedback(input, { workflow: null })).toBeNull();
    expect(
      decideSubagentFeedback(input, {
        workflow: {
          workflow_id: "wf",
          budget_tokens: null,
          used_tokens: 9999,
          pct: null,
        },
      }),
    ).toBeNull();
  });
});

describe("renderSubagentFeedback", () => {
  it("returns null for no message", () => {
    expect(renderSubagentFeedback(null)).toBeNull();
  });
  it("wraps a message in SubagentStop hookSpecificOutput", () => {
    const out = renderSubagentFeedback("wind down");
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SubagentStop");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("wind down");
  });
});

// Claude Code reports plugin agents under their namespace
// (`token-pilot:tp-demo`). The watchdog accepted bare `tp-*` names only,
// so a plugin install never had its response budgets checked.
describe("checkSubagentBudget — plugin-namespaced agents", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("checks the budget of a plugin-namespaced tp-* agent", async () => {
    root = await mkdtemp(join(tmpdir(), "tp-budget-"));
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(root, ".claude", "agents", "tp-demo.md"),
      "---\nname: tp-demo\n---\nResponse budget: ~100 tokens.\n",
    );
    const transcript = join(root, "t.jsonl");
    await writeFile(
      transcript,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "word ".repeat(2000) }],
        },
      }),
    );

    const advice = await checkSubagentBudget(root, root, {
      agent_type: "token-pilot:tp-demo",
      agent_transcript_path: transcript,
    });

    expect(advice).not.toBeNull();
  });
});

// Claude Code 2.1.271 moved the subagent's report into a `SubagentHandback`
// tool call. The last assistant TEXT block is now a stub ("Done." or less),
// so measuring it reported ~4 tokens for a 5 KB report and the response
// budget could never be exceeded.
describe("finalResponseTokens — report delivered through SubagentHandback", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("measures the handback message, not the text stub around it", async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-handback-"));
    const p = join(dir, "t.jsonl");
    const report = "word ".repeat(400);
    await writeFile(
      p,
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Handing back." }],
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", name: "SubagentHandback", input: { message: report } },
            ],
          },
        }),
      ].join("\n"),
    );

    const tokens = finalResponseTokens(p);

    // ~500 tokens for the report; the "Handing back." stub is ~3.
    expect(tokens).toBeGreaterThan(300);
  });

  it("still falls back to the last text turn when there is no handback", async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-handback-"));
    const p = join(dir, "t.jsonl");
    await writeFile(
      p,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "word ".repeat(400) }],
        },
      }),
    );

    expect(finalResponseTokens(p)).toBeGreaterThan(300);
  });
});
