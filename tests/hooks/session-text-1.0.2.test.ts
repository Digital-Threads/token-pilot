/**
 * 1.0.2 audit, item 19: Codex got the Claude Code text (tp-* agents,
 * Read/Grep). Codex reads code through the shell and has no tp-* agents.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSessionStart } from "../../src/hooks/session-start.ts";
import { buildPromptReminder } from "../../src/hooks/user-prompt.ts";
import { createCodexHookConfig } from "../../src/hooks/codex-installer.ts";

describe("Codex gets Codex text", () => {
  it("session start names no Claude Code tool or agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-session-codex-"));
    try {
      const out = await handleSessionStart({
        projectRoot: dir,
        homeDir: dir,
        sessionStartConfig: { enabled: true, showStats: false },
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
  });

  it("the Codex install asks for the Codex anchor", () => {
    const cfg = createCodexHookConfig();
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--client=codex");
  });
});
