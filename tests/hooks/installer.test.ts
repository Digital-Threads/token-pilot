import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHook, uninstallHook } from "../../src/hooks/installer.js";

describe("Hook Installer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "token-pilot-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("installs hook in fresh project (no .claude dir)", async () => {
    const result = await installHook(tempDir);
    expect(result.installed).toBe(true);
    expect(result.message).toContain("Hooks installed");

    const settings = JSON.parse(
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8"),
    );
    // v0.31.0 — 6 PreToolUse matchers: Read, Edit, MultiEdit, Bash,
    // Grep, Task. Task added for subagent routing enforcement.
    // Write was matched briefly in v0.30.0-0.30.2 but removed — Write
    // replaces a whole file and has no old_string to prep against, so
    // enforcing read_for_edit on it blocked legit script regeneration.
    expect(settings.hooks.PreToolUse).toHaveLength(6);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Read");
    expect(settings.hooks.PreToolUse[1].matcher).toBe("Edit");
    expect(settings.hooks.PreToolUse[2].matcher).toBe("MultiEdit");
    expect(settings.hooks.PreToolUse[3].matcher).toBe("Bash");
    expect(settings.hooks.PreToolUse[4].matcher).toBe("Grep");
    expect(settings.hooks.PreToolUse[5].matcher).toBe("Task");
  });

  it("installs hook alongside existing settings", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "settings.json"),
      JSON.stringify({ someOtherSetting: true }),
    );

    const result = await installHook(tempDir);
    expect(result.installed).toBe(true);

    const settings = JSON.parse(
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(6);
  });

  it("does not double-install", async () => {
    await installHook(tempDir);
    const result = await installHook(tempDir);
    expect(result.installed).toBe(false);
    expect(result.message).toContain("already installed");
  });

  it("uninstalls hook", async () => {
    await installHook(tempDir);
    const result = await uninstallHook(tempDir);
    expect(result.removed).toBe(true);

    const settings = JSON.parse(
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.hooks).toBeUndefined();
  });

  it("uninstall reports nothing to remove", async () => {
    const result = await uninstallHook(tempDir);
    expect(result.removed).toBe(false);
    expect(result.fatal).toBe(false);
  });

  it("re-install adds missing PostToolUse matchers from older versions (v0.25.0 regression)", async () => {
    // Simulate a v0.21.0 install: PostToolUse has only the Bash matcher
    // (Task matcher was added in v0.23.0). Previously the idempotence
    // check treated "any token-pilot hook in PostToolUse" as "all
    // installed" and silently skipped the Task matcher, so upgrading
    // users never got the budget watchdog. Now re-install must pick it
    // up.
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "token-pilot hook-read" }],
            },
            {
              matcher: "Edit",
              hooks: [{ type: "command", command: "token-pilot hook-edit" }],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "token-pilot hook-session-start",
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "token-pilot hook-post-bash",
                },
              ],
            },
          ],
        },
      }),
    );

    const result = await installHook(tempDir);
    expect(result.installed).toBe(true);

    const settings = JSON.parse(
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8"),
    );
    const matchers = settings.hooks.PostToolUse.map((h: any) => h.matcher);
    expect(matchers).toContain("Bash");
    expect(matchers).toContain("Task");
  });

  it("reports invalid JSON as a fatal install error", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await writeFile(join(tempDir, ".claude", "settings.json"), "{not json");

    const result = await installHook(tempDir);
    expect(result.installed).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.message).toContain("invalid JSON");
  });

  it("keeps packaged hook config in sync with installer hooks", async () => {
    const packaged = JSON.parse(
      await readFile(join(process.cwd(), "hooks", "hooks.json"), "utf-8"),
    );

    const preToolUse = packaged.hooks.PreToolUse;
    // v0.30.3 — Edit and MultiEdit share hook-edit enforcement. Write used
    // to be matched too but was removed in v0.30.3: Write replaces the
    // whole file (no old_string to prep), and blocking it hit legit
    // script-regeneration flows.
    expect(preToolUse).toHaveLength(6);
    expect(preToolUse.map((hook: { matcher: string }) => hook.matcher)).toEqual(
      ["Read", "Edit", "MultiEdit", "Bash", "Grep", "Task"],
    );
    expect(preToolUse[0].hooks[0].command).toContain("hook-read");
    expect(preToolUse[1].hooks[0].command).toContain("hook-edit");
    expect(preToolUse[2].hooks[0].command).toContain("hook-edit");
    expect(preToolUse[3].hooks[0].command).toContain("hook-pre-bash");
    expect(preToolUse[4].hooks[0].command).toContain("hook-pre-grep");
  });

  it("uses absolute paths when scriptPath is provided", async () => {
    const result = await installHook(tempDir, {
      scriptPath: "/usr/local/lib/node_modules/token-pilot/dist/index.js",
      nodeExecPath: "/usr/local/bin/node",
    });
    expect(result.installed).toBe(true);

    const settings = JSON.parse(
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8"),
    );
    const readHook = settings.hooks.PreToolUse.find(
      (h: any) => h.matcher === "Read",
    );
    expect(readHook.hooks[0].command).toBe(
      "/usr/local/bin/node /usr/local/lib/node_modules/token-pilot/dist/index.js hook-read",
    );
    const editHook = settings.hooks.PreToolUse.find(
      (h: any) => h.matcher === "Edit",
    );
    expect(editHook.hooks[0].command).toBe(
      "/usr/local/bin/node /usr/local/lib/node_modules/token-pilot/dist/index.js hook-edit",
    );
  });

  it("skips install when running as plugin (CLAUDE_PLUGIN_ROOT set)", async () => {
    const orig = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = "/some/plugin/path";
    try {
      const result = await installHook(tempDir);
      expect(result.installed).toBe(false);
      expect(result.message).toContain("plugin");
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = orig;
    }
  });

  it('replaces old bare "token-pilot" hooks with absolute paths', async () => {
    // Simulate old broken hooks
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "token-pilot hook-read" }],
            },
            {
              matcher: "Edit",
              hooks: [{ type: "command", command: "token-pilot hook-edit" }],
            },
          ],
        },
      }),
    );

    const result = await installHook(tempDir, {
      scriptPath: "/opt/node/lib/token-pilot/dist/index.js",
      nodeExecPath: "/opt/node/bin/node",
    });
    expect(result.installed).toBe(true);

    const settings = JSON.parse(
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8"),
    );
    const readHook = settings.hooks.PreToolUse.find(
      (h: any) => h.matcher === "Read",
    );
    expect(readHook.hooks[0].command).toContain("/opt/node/bin/node");
    expect(readHook.hooks[0].command).not.toBe("token-pilot hook-read");
  });
});
