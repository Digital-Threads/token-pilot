/**
 * With token-pilot's MCP server switched off for the project (/mcp writes it
 * to disabledMcpServers), the command hooks refuse nothing: a refusal would
 * send the model to tools it does not have. With the server on, a whole-file
 * read of a big code file is still refused.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIST_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

let dir: string;
let project: string;
let configDir: string;
let big: string;

function hook(action: string, input: unknown, disabled: string[]): string {
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ projects: { [project]: { disabledMcpServers: disabled } } }),
  );
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: configDir };
  for (const k of ["TOKEN_PILOT_BYPASS", "TOKEN_PILOT_MODE", "TOKEN_PILOT_MOD", "TOKEN_PILOT_MOD_SESSION", "TOKEN_PILOT_DENY_THRESHOLD"]) delete env[k];

  return spawnSync("node", [DIST_ENTRY, action], {
    cwd: project,
    input: JSON.stringify(input),
    encoding: "utf-8",
    env,
  }).stdout;
}

const read = { tool_name: "Read", tool_input: { file_path: "" } };
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tp-no-mcp-"));
  project = join(dir, "project");
  configDir = join(dir, "config");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(configDir);
  big = join(project, "big.ts");
  writeFileSync(big, Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
  read.tool_input.file_path = big;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("command hooks with the MCP server off", () => {
  for (const name of ["token-pilot", "plugin:token-pilot:token-pilot"]) {
    it(`a whole-file Read passes when ${name} is off`, () => {
      expect(hook("hook-read", read, [name])).toBe("");
    });
  }

  it("a cat of a code file passes", () => {
    expect(hook("hook-pre-bash", bash(`cat ${big}`), ["token-pilot"])).toBe("");
  });

  it("a symbol Grep passes", () => {
    expect(hook("hook-pre-grep", { tool_name: "Grep", tool_input: { pattern: "handleSessionStart" } }, ["token-pilot"])).toBe("");
  });

  it("a test run gets no advice to use test_summary", () => {
    expect(hook("hook-pre-bash", bash("npx vitest run"), ["token-pilot"])).toBe("");
  });
});

describe("command hooks with the MCP server on", () => {
  it("a whole-file Read of a big code file is still refused", () => {
    expect(hook("hook-read", read, ["context-mode"])).toContain('"permissionDecision":"deny"');
  });

  it("a cat of a code file is still refused", () => {
    expect(hook("hook-pre-bash", bash(`cat ${big}`), [])).toContain('"permissionDecision":"deny"');
  });

  it("a small sed range passes", () => {
    expect(hook("hook-pre-bash", bash(`sed -n 1,50p ${big}`), [])).toBe("");
  });

  it("a Read of 200 lines with offset/limit passes", () => {
    const ranged = { tool_name: "Read", tool_input: { file_path: big, offset: 100, limit: 200 } };
    expect(hook("hook-read", ranged, [])).toBe("");
  });

  // The adaptive threshold tightens whole-file reads late in a long session;
  // a range the agent chose within the base threshold still passes.
  it("a Read of 200 lines with offset/limit passes late in a long session", () => {
    mkdirSync(join(project, ".token-pilot"), { recursive: true });
    writeFileSync(
      join(project, ".token-pilot", "hook-events.jsonl"),
      JSON.stringify({ ts: Date.now(), session_id: "s-long", event: "denied", savedTokens: 95_000 }) + "\n",
    );
    const ranged = { session_id: "s-long", tool_name: "Read", tool_input: { file_path: big, offset: 100, limit: 200 } };

    expect(hook("hook-read", ranged, [])).toBe("");
  });
});
