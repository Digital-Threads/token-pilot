/**
 * SubagentStop is the one place a dispatch is counted: it sees the final
 * answer of foreground and background agents alike, while PostToolUse on
 * Agent only sees a background agent's launch acknowledgement. A second
 * PostToolUse hook doubled every task event and over-budget line, so the
 * plugin and the npm installer no longer register it, and the installer
 * removes the one older versions wrote.
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

const postTaskEntries = (hooks: any): any[] =>
  (hooks.PostToolUse ?? []).filter((e: any) =>
    e.hooks.some((h: any) => String(h.command).includes("hook-post-task")),
  );

const subagentStop = (hooks: any): boolean =>
  (hooks.SubagentStop ?? []).some((e: any) =>
    e.hooks.some((h: any) => String(h.command).includes("hook-subagent-stop")),
  );

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

describe("dispatches are counted once, by SubagentStop", () => {
  it("the plugin's hooks.json registers no PostToolUse dispatch hook", async () => {
    const json = JSON.parse(
      await readFile(join(__dirname, "../../hooks/hooks.json"), "utf-8"),
    );

    expect(postTaskEntries(json.hooks)).toEqual([]);
    expect(subagentStop(json.hooks)).toBe(true);
  });

  it("the npm installer writes none and removes the one older versions wrote", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Task", hooks: [{ type: "command", command: "npx token-pilot hook-post-task" }] },
            { matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] },
          ],
        },
      }),
    );

    await installHook(dir);
    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.json"), "utf-8"),
    );

    expect(postTaskEntries(settings.hooks)).toEqual([]);
    expect(settings.hooks.PostToolUse.some((e: any) => e.matcher === "Bash")).toBe(true);
    expect(subagentStop(settings.hooks)).toBe(true);
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
