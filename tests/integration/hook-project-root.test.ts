/**
 * 1.0.2 audit — command hooks took process.cwd() as the project root. After
 * a `cd src` a big Read elsewhere in the project passed ungated, and config
 * and telemetry went to the subdirectory. The root is CLAUDE_PROJECT_DIR,
 * else the nearest `.git` ancestor, else cwd.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIST_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

function hook(action: string, payload: unknown, cwd: string, env: Record<string, string> = {}) {
  const base = { ...process.env };
  for (const k of ["CLAUDE_PROJECT_DIR", "TOKEN_PILOT_BYPASS", "TOKEN_PILOT_MODE", "TOKEN_PILOT_MOD"]) delete base[k];

  const run = spawnSync("node", [DIST_ENTRY, action], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...base, ...env },
  });

  return run.stdout;
}

let project: string;
let big: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "tp-root-"));
  mkdirSync(join(project, ".git"));
  mkdirSync(join(project, "src"));
  big = join(project, "big.ts");
  writeFileSync(big, Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("command hooks find the project root", () => {
  it("hook-read gates a big file elsewhere in the project after cd src", () => {
    const out = hook("hook-read", { tool_name: "Read", tool_input: { file_path: big } }, join(project, "src"));

    expect(out).toContain('"permissionDecision":"deny"');
    expect(existsSync(join(project, ".token-pilot"))).toBe(true);
    expect(existsSync(join(project, "src", ".token-pilot"))).toBe(false);
  });

  it("hook-read prefers CLAUDE_PROJECT_DIR over cwd", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tp-cwd-"));
    try {
      const out = hook("hook-read", { tool_name: "Read", tool_input: { file_path: big } }, elsewhere, {
        CLAUDE_PROJECT_DIR: project,
      });
      expect(out).toContain('"permissionDecision":"deny"');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("hook-pre-bash knows a find inside the project from one outside it", () => {
    const run = (command: string) =>
      hook("hook-pre-bash", { tool_name: "Bash", tool_input: { command } }, join(project, "src"));

    expect(run(`find ${project}/src -name '*.ts'`)).toBe("");
    expect(run("find /usr -name '*.h'")).toContain('"permissionDecision":"deny"');
  });
});
