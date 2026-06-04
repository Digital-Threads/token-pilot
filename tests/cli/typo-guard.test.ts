/**
 * v0.22.3 — typo guard for CLI commands.
 *
 * The bug: `npx token-pilot install-aents` (missing 'g') silently became
 * a projectRoot=install-aents server launch, creating stray
 * `install-aents/.claude/settings.json` directories. The guard intercepts
 * command-like first args that don't match the allow-list and aren't
 * valid paths, suggesting the closest real command.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForTypo } from "../../src/cli/typo-guard.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-typo-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("checkForTypo", () => {
  it("passes through when no arg", () => {
    expect(checkForTypo(undefined).kind).toBe("pass-through");
    expect(checkForTypo("").kind).toBe("pass-through");
  });

  it("passes through known commands", () => {
    expect(checkForTypo("install-agents").kind).toBe("pass-through");
    expect(checkForTypo("doctor").kind).toBe("pass-through");
    expect(checkForTypo("--version").kind).toBe("pass-through");
    expect(checkForTypo("save-doc").kind).toBe("pass-through");
  });

  it("passes through absolute / relative paths", () => {
    expect(checkForTypo("/home/user/project").kind).toBe("pass-through");
    expect(checkForTypo("./sub").kind).toBe("pass-through");
    expect(checkForTypo("../sibling").kind).toBe("pass-through");
    expect(checkForTypo("a/b/c").kind).toBe("pass-through");
  });

  it("passes through single-word args (non-kebab)", () => {
    // These are likely project-root names, not intended commands.
    expect(checkForTypo("myproject").kind).toBe("pass-through");
    expect(checkForTypo("work").kind).toBe("pass-through");
  });

  it("passes through when arg is an existing directory", () => {
    // tempDir is a real dir — should pass through regardless of shape.
    expect(checkForTypo(tempDir).kind).toBe("pass-through");
  });

  it("catches install-aents → install-agents", () => {
    const r = checkForTypo("install-aents");
    expect(r.kind).toBe("typo");
    expect(r.suggestion).toBe("install-agents");
    expect(r.message).toContain('Did you mean "install-agents"');
  });

  it("catches unistall-hook → uninstall-hook", () => {
    const r = checkForTypo("unistall-hook");
    expect(r.kind).toBe("typo");
    expect(r.suggestion).toBe("uninstall-hook");
  });

  it("catches list-doc → list-docs", () => {
    const r = checkForTypo("list-doc");
    expect(r.kind).toBe("typo");
    expect(r.suggestion).toBe("list-docs");
  });

  it("reports unknown command with no suggestion when nothing is close", () => {
    const r = checkForTypo("frobnicate-widgets");
    expect(r.kind).toBe("typo");
    expect(r.suggestion).toBeUndefined();
    expect(r.message).toContain("token-pilot --help");
  });

  // v0.33.0 — regression guard. Every command we add to the
  // index.ts switch MUST also live in KNOWN_COMMANDS, otherwise the
  // typo-guard rejects the call with exit 1 before the switch even
  // fires. This is exactly how `hook-pre-task` (v0.31.0) silently
  // disabled itself for weeks until tool-audit data showed 0 task
  // events on every machine. List the entire current set of public
  // commands here so a future addition without registry update fails
  // loudly in CI rather than silently in production.
  it.each([
    // hook entry points (Claude Code calls these via hooks/hooks.json)
    "hook-read",
    "hook-edit",
    "hook-pre-bash",
    "hook-pre-grep",
    "hook-pre-task",
    "hook-post-bash",
    "hook-post-task",
    "hook-session-start",
    "hook-bootstrap",
    "hook-subagent-stop",
    // user-facing CLI
    "install-hook",
    "uninstall-hook",
    "install-ast-index",
    "install-agents",
    "uninstall-agents",
    "bless-agents",
    "unbless-agents",
    "stats",
    "tool-audit",
    "save-doc",
    "list-docs",
    "init",
    "doctor",
    "migrate-hooks",
    "errors",
    "workflow",
  ])(
    "%s passes the typo-guard (must be in KNOWN_COMMANDS)",
    (cmd) => {
      expect(checkForTypo(cmd).kind).toBe("pass-through");
    },
  );
});
