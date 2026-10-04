/**
 * 1.0.2 audit, item 20 — the Edit gate advised read_for_edit right after the
 * agent wrote the file itself. A Write gives the agent every byte; it counts
 * as prepared, on the command-hook path as in the mod.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIST_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

let project: string;

function hookEdit(tool: string, file: string): string {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project };
  for (const k of ["TOKEN_PILOT_BYPASS", "TOKEN_PILOT_MODE", "TOKEN_PILOT_MOD"]) delete env[k];

  return spawnSync("node", [DIST_ENTRY, "hook-edit"], {
    cwd: project,
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path: file, content: "x" } }),
    encoding: "utf-8",
    env,
  }).stdout;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "tp-edit-write-"));
  mkdirSync(join(project, ".git"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("hook-edit after the agent's own Write", () => {
  it("advises on an Edit of a file nobody prepared", () => {
    const file = join(project, "a.ts");
    writeFileSync(file, "export const a = 1;\n");

    expect(hookEdit("Edit", file)).toContain("read_for_edit");
  });

  it("stays quiet on an Edit of a file the agent just wrote", () => {
    const file = join(project, "b.ts");
    expect(hookEdit("Write", file)).toBe("");
    writeFileSync(file, "export const b = 1;\n");

    expect(hookEdit("Edit", file)).toBe("");
  });

  it("the plugin routes Write to hook-edit", () => {
    const json = JSON.parse(readFileSync(resolve(__dirname, "../../hooks/hooks.json"), "utf-8"));
    const write = json.hooks.PreToolUse.find((e: any) => new RegExp(`^(?:${e.matcher})$`).test("Write"));

    expect(write?.hooks[0].command).toContain("hook-edit");
  });
});
