/**
 * hooks/run.sh steps aside for every action the Claude Code mod already
 * serves in-process (TOKEN_PILOT_MOD, set by the mod at session start), and
 * runs the hook as before otherwise — old Claude Code, mods turned off, or a
 * mod that failed to load. The variable reaches every process the session
 * starts, so a nested `claude` inherits it: run.sh steps aside only for the
 * session that set it (TOKEN_PILOT_MOD_SESSION).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const payload = (sessionId: string) =>
  JSON.stringify({
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: "cat src/index.ts" },
  });

const run = (action: string, flag: string, input: string, session = "s-parent") =>
  spawnSync("sh", ["hooks/run.sh", action], {
    input,
    encoding: "utf8",
    env: { ...process.env, TOKEN_PILOT_MOD: flag, TOKEN_PILOT_MOD_SESSION: session },
  });

describe("hooks/run.sh hand-off to the mod", () => {
  it("exits silently when the mod serves the action in this session", () => {
    const r = run("hook-pre-bash", "hook-read,hook-pre-bash", payload("s-parent"));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("still runs the hook for a near-miss or an empty flag", () => {
    for (const flag of ["hook-pre", "hook-pre-bash-x", ""]) {
      expect(run("hook-pre-bash", flag, payload("s-parent")).stdout).toContain('"permissionDecision":"deny"');
    }
  });

  it("runs the hook in a nested session that inherited the flag", () => {
    const r = run("hook-pre-bash", "hook-pre-bash", payload("s-nested"));

    expect(r.stdout).toContain('"permissionDecision":"deny"');
  });

  it("steps aside for every session the mod has served (a background agent after /clear)", () => {
    const r = run("hook-pre-bash", "hook-pre-bash", payload("s-parent"), "s-new,s-parent");

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("matches a payload written with spaces after the colon", () => {
    const spaced = JSON.stringify({ session_id: "s-parent", tool_name: "Bash", tool_input: { command: "cat src/index.ts" } }, null, 1);

    expect(run("hook-pre-bash", "hook-pre-bash", spaced).stdout).toBe("");
  });

  it("decides with shell builtins: no grep, sed or head on the step-aside path", () => {
    const bin = mkdtempSync(join(tmpdir(), "tp-bin-"));
    symlinkSync(spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim(), join(bin, "cat"));

    const r = spawnSync("/bin/sh", ["hooks/run.sh", "hook-pre-bash"], {
      input: payload("s-parent"),
      encoding: "utf8",
      env: { PATH: bin, TOKEN_PILOT_MOD: "hook-pre-bash", TOKEN_PILOT_MOD_SESSION: "s-parent" },
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("hands the payload on byte for byte when it does not step aside", () => {
    // A stand-in node that echoes its stdin shows exactly what the hook gets.
    const bin = mkdtempSync(join(tmpdir(), "tp-node-"));
    writeFileSync(join(bin, "node"), "#!/bin/sh\ncat\n", { mode: 0o755 });
    const tricky = JSON.stringify({
      session_id: "s-nested",
      tool_name: "Bash",
      tool_input: { command: 'cat src/index.ts # "q" \\ $(id) `id` $HOME\nEOF\r' },
    });

    const r = spawnSync("sh", ["hooks/run.sh", "hook-pre-bash"], {
      input: tricky,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TOKEN_PILOT_MOD: "hook-pre-bash", TOKEN_PILOT_MOD_SESSION: "s-parent" },
    });

    expect(r.stdout).toBe(tricky + "\n");
  });

  it("looks only at the top-level session_id, not one inside the tool input", () => {
    const nested = JSON.stringify({
      session_id: "s-other",
      tool_name: "Bash",
      tool_input: { command: "cat src/index.ts", session_id: "s-parent" },
    });

    expect(run("hook-pre-bash", "hook-pre-bash", nested).stdout).toContain('"permissionDecision":"deny"');
  });

  it("runs the hook when the mod has not recorded a session", () => {
    expect(run("hook-pre-bash", "hook-pre-bash", payload(""), "").stdout).toContain('"permissionDecision":"deny"');
  });

  it("runs the hook when the payload carries no session id", () => {
    const r = run("hook-pre-bash", "hook-pre-bash", JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat src/index.ts" } }));

    expect(r.stdout).toContain('"permissionDecision":"deny"');
  });
});
