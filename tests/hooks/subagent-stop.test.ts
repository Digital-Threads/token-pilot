/**
 * Tests for v0.40.0 SubagentStop task-completion capture.
 *
 * buildSubagentTaskEvent is pure (token read injectable);
 * tokensFromTranscript is exercised against a tmp JSONL file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSubagentTaskEvent,
  tokensFromTranscript,
  decideSubagentFeedback,
  renderSubagentFeedback,
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
