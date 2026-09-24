/**
 * `install-hook --client=codex` picks the Codex target instead of Claude
 * Code's settings.json, and honours --scope=project. The handler returns an
 * exit code rather than calling process.exit, which is what makes this
 * testable at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleCodexHookCli,
  clientFlag,
  positional,
} from "../../src/index.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tp-codex-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("clientFlag / positional", () => {
  it("defaults to Claude Code and finds the root argument", () => {
    expect(clientFlag([])).toBe("claude-code");
    expect(clientFlag(["--client=codex"])).toBe("codex");
    expect(positional(["--scope=project", "/repo"])).toBe("/repo");
    expect(positional(["--client=codex"])).toBeUndefined();
  });
});

describe("handleCodexHookCli", () => {
  it("installs into <home>/.codex by default", async () => {
    const code = await handleCodexHookCli(["--client=codex"], "install", {
      homeDir: dir,
    });

    expect(code).toBe(0);
    const written = JSON.parse(
      await readFile(join(dir, ".codex", "hooks.json"), "utf-8"),
    );
    expect(written.hooks.PreToolUse[0].matcher).toBe("Bash");
  });

  it("installs into <root>/.codex with --scope=project", async () => {
    const code = await handleCodexHookCli(
      ["--client=codex", "--scope=project", dir],
      "install",
      { homeDir: "/nonexistent-home" },
    );

    expect(code).toBe(0);
    const written = JSON.parse(
      await readFile(join(dir, ".codex", "hooks.json"), "utf-8"),
    );
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstall clears what install wrote", async () => {
    await handleCodexHookCli(["--client=codex"], "install", { homeDir: dir });
    const code = await handleCodexHookCli(["--client=codex"], "uninstall", {
      homeDir: dir,
    });

    expect(code).toBe(0);
    const written = JSON.parse(
      await readFile(join(dir, ".codex", "hooks.json"), "utf-8"),
    );
    expect(written.hooks).toEqual({});
  });
});
