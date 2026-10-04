/**
 * 1.0.2 audit — the session text:
 *  - item 9: on a plugin install it said "none installed; run install-agents"
 *    although the plugin ships every tp-* agent (dispatched as
 *    `token-pilot:tp-*`);
 *  - item 15: it named tools that do not exist on Claude Code 2.1.289
 *    ("the Task tool") or signatures that fail (`outline(path)` on a file);
 *  - item 19: Codex got the Claude Code text (tp-* agents, Read/Grep).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildReminderMessage } from "../../src/hooks/session-context.ts";
import { handleSessionStart } from "../../src/hooks/session-start.ts";
import { MINIMAL_ANCHOR, buildPromptReminder } from "../../src/hooks/user-prompt.ts";
import { createCodexHookConfig } from "../../src/hooks/codex-installer.ts";

describe("session text — names", () => {
  it("lists plugin agents under their dispatch name", () => {
    const msg = buildReminderMessage([{ name: "token-pilot:tp-debugger", description: "bugs" }], 2000);
    expect(msg).toContain("→ token-pilot:tp-debugger");
    expect(msg).not.toMatch(/none installed/);
  });

  it("names no tool Claude Code does not have", () => {
    const msg = buildReminderMessage([{ name: "tp-debugger", description: "bugs" }], 2000);
    expect(msg).not.toContain("Task tool");
    expect(msg).not.toContain("outline(path)");
  });
});

describe("session start on a plugin install", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-session-plugin-"));
    await mkdir(join(dir, "plugin", "agents"), { recursive: true });
    await writeFile(
      join(dir, "plugin", "agents", "tp-debugger.md"),
      "---\nname: tp-debugger\ndescription: bugs\n---\n",
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the plugin's own agents", async () => {
    const out = await handleSessionStart({
      projectRoot: join(dir, "project"),
      homeDir: join(dir, "home"),
      pluginRoot: join(dir, "plugin"),
      sessionStartConfig: { enabled: true, showStats: false, maxReminderTokens: 2000 },
    });
    const msg = JSON.parse(out!).hookSpecificOutput.additionalContext as string;

    expect(msg).toContain("token-pilot:tp-debugger");
    expect(msg).not.toMatch(/none installed/);
  });
});

describe("Codex gets Codex text", () => {
  it("session start names no Claude Code tool or agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-session-codex-"));
    try {
      const out = await handleSessionStart({
        projectRoot: dir,
        homeDir: dir,
        sessionStartConfig: { enabled: true, showStats: false, maxReminderTokens: 2000 },
        client: "codex",
      });
      const msg = JSON.parse(out!).hookSpecificOutput.additionalContext as string;

      expect(msg).toContain("smart_read");
      expect(msg).not.toMatch(/\btp-|Task tool|Agent tool|\bRead\(|\bGrep\b/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the per-turn anchor for Codex names no Claude Code tool or agent", () => {
    const msg = buildPromptReminder(true, false, "codex")!;
    expect(msg).toContain("smart_read");
    expect(msg).not.toMatch(/\btp-|\bRead\b|\bGrep\b/);
    expect(MINIMAL_ANCHOR).toContain("tp-");
  });

  it("the Codex install asks for the Codex anchor", () => {
    const cfg = createCodexHookConfig();
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--client=codex");
  });
});
