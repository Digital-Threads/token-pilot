/**
 * hook-post-task never fired: its PostToolUse matcher was `Task`, while
 * Claude Code dispatches subagents through the `Agent` tool (`Task` is the
 * legacy name). Both the plugin's hooks.json and the npm installer must
 * match either name, and the handler must accept either.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHook } from "../../src/hooks/installer.ts";
import { processPostTask } from "../../src/hooks/post-task.ts";
import { loadEvents } from "../../src/core/event-log.ts";

const matches = (matcher: string, tool: string) =>
  new RegExp(`^(?:${matcher})$`).test(tool);

function postTaskMatcher(hooks: any): string {
  const entry = hooks.PostToolUse.find((e: any) =>
    e.hooks.some((h: any) => String(h.command).includes("hook-post-task")),
  );
  return entry.matcher;
}

let dir: string;
const saved = { home: process.env.HOME, root: process.env.CLAUDE_PLUGIN_ROOT };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tp-post-task-matcher-"));
  // installHook skips plugin installs; keep the machine's own setup out.
  delete process.env.CLAUDE_PLUGIN_ROOT;
  process.env.HOME = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  process.env.HOME = saved.home;
  if (saved.root === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = saved.root;
});

describe("hook-post-task matcher", () => {
  it("the plugin's hooks.json fires it for Agent and for the legacy Task", async () => {
    const json = JSON.parse(
      await readFile(join(__dirname, "../../hooks/hooks.json"), "utf-8"),
    );
    const matcher = postTaskMatcher(json.hooks);

    expect(matches(matcher, "Agent")).toBe(true);
    expect(matches(matcher, "Task")).toBe(true);
  });

  it("the npm installer writes a matcher for Agent and Task", async () => {
    await installHook(dir);
    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.json"), "utf-8"),
    );
    const matcher = postTaskMatcher(settings.hooks);

    expect(matches(matcher, "Agent")).toBe(true);
    expect(matches(matcher, "Task")).toBe(true);
  });

  it("handles a dispatch made through the Agent tool", async () => {
    await processPostTask(dir, dir, {
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", description: "x" },
      session_id: "s1",
    } as any);

    const events = await loadEvents(dir);
    expect(events.map((e) => e.event)).toEqual(["task"]);
  });
});
