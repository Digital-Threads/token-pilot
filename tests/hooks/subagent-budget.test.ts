/**
 * v0.49.0 — the tp-* response-budget watchdog, revived.
 *
 * The budget check has lived in PostToolUse:Task since v0.37.0, but that
 * hook does not fire for the dispatch tool on current Claude Code (noted
 * in installer.ts since v0.39.3). Consequence: `.token-pilot/over-budget.log`
 * never appeared and every recorded task event carried a null budget — the
 * watchdog has been dead for months without anyone noticing.
 *
 * SubagentStop is where subagent completions actually arrive, so the check
 * belongs here. The measured value is the size of the agent's FINAL reply,
 * not the sum of everything it emitted along the way: the agents declare
 * "Response budget: ~N tokens", which is about the answer they hand back.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  finalResponseTokens,
  checkSubagentBudget,
} from "../../src/hooks/subagent-stop.ts";

/** One JSONL line in the shape Claude Code writes for a subagent turn. */
function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { output_tokens: 10 },
    },
  });
}

function toolUseLine(): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      usage: { output_tokens: 40 },
    },
  });
}

describe("finalResponseTokens", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-budget-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function transcript(lines: string[]): Promise<string> {
    const p = join(dir, "agent.jsonl");
    await writeFile(p, lines.join("\n") + "\n");
    return p;
  }

  it("returns 0 for a missing or unreadable path", async () => {
    expect(finalResponseTokens(undefined)).toBe(0);
    expect(finalResponseTokens(join(dir, "nope.jsonl"))).toBe(0);
  });

  it("measures the last assistant text, not the whole transcript", async () => {
    const p = await transcript([
      assistantLine("x".repeat(4000)),
      assistantLine("short answer"),
    ]);
    // Only the final reply counts, so this stays tiny despite the 4000-char
    // turn before it.
    expect(finalResponseTokens(p)).toBeLessThan(10);
    expect(finalResponseTokens(p)).toBeGreaterThan(0);
  });

  it("ignores tool_use blocks that follow the last text block", async () => {
    const p = await transcript([
      assistantLine("the real answer"),
      toolUseLine(),
    ]);
    expect(finalResponseTokens(p)).toBeGreaterThan(0);
    expect(finalResponseTokens(p)).toBeLessThan(10);
  });

  it("survives malformed lines", async () => {
    const p = await transcript([
      "not json{{{",
      assistantLine("still readable"),
      "",
    ]);
    expect(finalResponseTokens(p)).toBeGreaterThan(0);
  });

  it("returns 0 when the agent produced no text reply", async () => {
    const p = await transcript([toolUseLine()]);
    expect(finalResponseTokens(p)).toBe(0);
  });
});

describe("checkSubagentBudget", () => {
  let projectRoot: string;
  let homeDir: string;

  /** Write an agent definition carrying a response budget. */
  async function writeAgent(name: string, budget: number | null) {
    const agentsDir = join(projectRoot, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    const body =
      budget === null
        ? `---\nname: ${name}\n---\n\nNo budget declared.\n`
        : `---\nname: ${name}\n---\n\nResponse budget: ~${budget} tokens\n`;
    await writeFile(join(agentsDir, `${name}.md`), body);
  }

  async function writeTranscript(text: string): Promise<string> {
    const p = join(projectRoot, "agent.jsonl");
    await writeFile(p, assistantLine(text) + "\n");
    return p;
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "tp-budget-proj-"));
    homeDir = await mkdtemp(join(tmpdir(), "tp-budget-home-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("ignores agents that are not tp-*", async () => {
    const transcriptPath = await writeTranscript("x".repeat(8000));
    const msg = await checkSubagentBudget(projectRoot, homeDir, {
      agent_type: "general-purpose",
      agent_transcript_path: transcriptPath,
    });
    expect(msg).toBeNull();
  });

  it("stays silent when the reply fits the budget", async () => {
    await writeAgent("tp-debugger", 600);
    const transcriptPath = await writeTranscript("a short answer");
    const msg = await checkSubagentBudget(projectRoot, homeDir, {
      agent_type: "tp-debugger",
      agent_transcript_path: transcriptPath,
    });
    expect(msg).toBeNull();
  });

  it("flags a reply that overruns the budget and logs it", async () => {
    await writeAgent("tp-debugger", 100);
    const transcriptPath = await writeTranscript("x".repeat(8000));
    const msg = await checkSubagentBudget(projectRoot, homeDir, {
      agent_type: "tp-debugger",
      agent_transcript_path: transcriptPath,
    });
    expect(msg).toContain("tp-debugger");
    expect(msg).toContain("100");

    const log = await readFile(
      join(projectRoot, ".token-pilot", "over-budget.log"),
      "utf-8",
    );
    expect(log).toContain("tp-debugger");
  });

  it("stays silent when the agent declares no budget", async () => {
    await writeAgent("tp-debugger", null);
    const transcriptPath = await writeTranscript("x".repeat(8000));
    const msg = await checkSubagentBudget(projectRoot, homeDir, {
      agent_type: "tp-debugger",
      agent_transcript_path: transcriptPath,
    });
    expect(msg).toBeNull();
  });

  it("stays silent when the agent file cannot be found", async () => {
    const transcriptPath = await writeTranscript("x".repeat(8000));
    const msg = await checkSubagentBudget(projectRoot, homeDir, {
      agent_type: "tp-nonexistent",
      agent_transcript_path: transcriptPath,
    });
    expect(msg).toBeNull();
  });

  it("never throws when the transcript is missing", async () => {
    await writeAgent("tp-debugger", 100);
    const msg = await checkSubagentBudget(projectRoot, homeDir, {
      agent_type: "tp-debugger",
      agent_transcript_path: join(projectRoot, "gone.jsonl"),
    });
    expect(msg).toBeNull();
  });
});
