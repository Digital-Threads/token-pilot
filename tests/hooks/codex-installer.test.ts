/**
 * Codex CLI grew the same lifecycle-hook protocol Claude Code uses. These
 * tests pin what we write into `<codex dir>/hooks.json` — and, just as
 * important, what we deliberately leave out: Codex has no file-read tool and
 * its `apply_patch` payload is a patch string, not Claude Code's
 * file_path/old_string, so those handlers would misread it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCodexHookConfig,
  installCodexHook,
  uninstallCodexHook,
} from "../../src/hooks/codex-installer.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tp-codex-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createCodexHookConfig", () => {
  it("wires only the events whose payload our handlers already read", () => {
    const cfg = createCodexHookConfig({ scriptPath: "/tp/dist/index.js" });

    expect(Object.keys(cfg.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    expect(cfg.hooks.PreToolUse.map((e) => e.matcher)).toEqual(["Bash"]);
    expect(cfg.hooks.PostToolUse.map((e) => e.matcher)).toEqual(["Bash"]);
  });

  it("leaves out the matchers whose payload differs from Claude Code", () => {
    const serialised = JSON.stringify(createCodexHookConfig());

    for (const absent of ["Read", "Grep", "MultiEdit", "apply_patch", "Edit"]) {
      expect(serialised).not.toContain(`"matcher": "${absent}"`);
      expect(serialised).not.toContain(`"${absent}"`);
    }
  });

  it("dispatches each event to its own handler", () => {
    const cfg = createCodexHookConfig({ scriptPath: "/tp/dist/index.js" });

    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toContain("hook-pre-bash");
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toContain(
      "hook-post-bash",
    );
    // The flag is what keeps Claude Code's `watchPaths` out of the reply,
    // which Codex rejects.
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook-session-start --client=codex",
    );
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "hook-user-prompt",
    );
  });
});

describe("installCodexHook", () => {
  it("writes hooks.json into a fresh .codex dir and says trust is needed", async () => {
    const result = await installCodexHook(join(dir, ".codex"));

    expect(result.installed).toBe(true);
    expect(result.message).toMatch(/\/hooks/);
    const written = JSON.parse(
      await readFile(join(dir, ".codex", "hooks.json"), "utf-8"),
    );
    expect(written.hooks.PreToolUse[0].matcher).toBe("Bash");
  });

  it("keeps hooks that are not ours and is idempotent", async () => {
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(
      join(dir, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] },
          ],
        },
      }),
    );

    await installCodexHook(join(dir, ".codex"));
    await installCodexHook(join(dir, ".codex"));

    const written = JSON.parse(
      await readFile(join(dir, ".codex", "hooks.json"), "utf-8"),
    );
    const commands = written.hooks.PreToolUse.flatMap((e: any) =>
      e.hooks.map((h: any) => h.command),
    );
    expect(commands).toContain("audit.sh");
    expect(commands.filter((c: string) => c.includes("hook-pre-bash"))).toHaveLength(1);
  });

  it("uninstall removes our entries and leaves the rest", async () => {
    await installCodexHook(join(dir, ".codex"));
    const result = await uninstallCodexHook(join(dir, ".codex"));

    expect(result.removed).toBe(true);
    const written = JSON.parse(
      await readFile(join(dir, ".codex", "hooks.json"), "utf-8"),
    );
    expect(JSON.stringify(written)).not.toContain("token-pilot");
  });
});
