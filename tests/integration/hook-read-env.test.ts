/**
 * 1.0.2 audit — the Read gate ignored the environment it documents:
 *  - TOKEN_PILOT_BYPASS=1 was advertised but never read;
 *  - TOKEN_PILOT_MODE=advisory ("everything passes") still denied;
 *  - TOKEN_PILOT_DENY_THRESHOLD and the adaptive vars counted only when a
 *    .token-pilot.json existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIST_ENTRY = resolve(__dirname, "..", "..", "dist", "index.js");

let project: string;
let big: string;

function read(env: Record<string, string> = {}): string {
  const base = { ...process.env };
  for (const k of ["CLAUDE_PROJECT_DIR", "TOKEN_PILOT_BYPASS", "TOKEN_PILOT_MODE", "TOKEN_PILOT_MOD", "TOKEN_PILOT_DENY_THRESHOLD"]) delete base[k];

  return spawnSync("node", [DIST_ENTRY, "hook-read"], {
    cwd: project,
    input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: big } }),
    encoding: "utf-8",
    env: { ...base, ...env },
  }).stdout;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "tp-read-env-"));
  mkdirSync(join(project, ".git"));
  big = join(project, "big.ts");
  writeFileSync(big, Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("hook-read and the environment", () => {
  it("gates a big file by default", () => {
    expect(read()).toContain('"permissionDecision":"deny"');
  });

  it("passes everything with TOKEN_PILOT_BYPASS=1", () => {
    expect(read({ TOKEN_PILOT_BYPASS: "1" })).toBe("");
  });

  it("passes everything with TOKEN_PILOT_MODE=advisory", () => {
    expect(read({ TOKEN_PILOT_MODE: "advisory" })).toBe("");
  });

  it("honours TOKEN_PILOT_DENY_THRESHOLD without a .token-pilot.json", () => {
    expect(read({ TOKEN_PILOT_DENY_THRESHOLD: "1000" })).toBe("");
  });

  it("does not tell the agent to set an env var it cannot set", () => {
    const out = read();
    expect(out).not.toContain("set TOKEN_PILOT_BYPASS=1");
    // A bounded Read passes only up to the threshold — say so.
    expect(out).toContain("limit");
    expect(out).toContain("300");
  });
});
