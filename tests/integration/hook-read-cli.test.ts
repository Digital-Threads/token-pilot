import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end CLI integration: spawn `node dist/index.js hook-read`, feed
 * Claude Code-style JSON on stdin, and assert on the captured stdout.
 *
 * These tests cover the five scenarios from TP-d4h subtask 1.9:
 *   1. Large unbounded code file → deny-enhanced JSON with a structural summary.
 *   2. Small code file (under threshold) → pass-through (empty stdout).
 *   3. Non-code file (e.g. JSON config) → pass-through.
 *   4. Bounded Read (offset + limit present) → pass-through.
 *   5. Missing file → pass-through (never errors the agent).
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

function runHook(
  stdinPayload: string,
  cwd: string,
  timeoutMs = 10000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [DIST_ENTRY, "hook-read"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

let tempDir: string;

beforeAll(() => {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `Integration test prerequisite missing: ${DIST_ENTRY}. ` +
        `Run \`npm run build\` before the integration suite.`,
    );
  }
});

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-hook-cli-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("hook-read CLI integration", () => {
  it("denies a large unbounded code Read with an enhanced structural summary", async () => {
    const filePath = join(tempDir, "big.ts");
    const body = [
      "import { foo } from './foo';",
      "import bar from 'bar';",
      "",
      ...Array.from({ length: 400 }, (_, i) => `const var${i} = ${i};`),
      "",
      "export function greet(name: string): string {",
      "  return `hi ${name}`;",
      "}",
      "",
      "export class Greeter {",
      "  constructor(private name: string) {}",
      "}",
      "",
      ...Array.from({ length: 200 }, (_, i) => `// tail ${i}`),
    ].join("\n");
    await writeFile(filePath, body);

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    const { stdout, code } = await runHook(stdin, tempDir);

    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    const reason: string = parsed.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/structural summary/i);
    expect(reason).toMatch(/greet/);
    expect(reason).toMatch(/How to proceed/);
    expect(reason).toMatch(/mcp__token-pilot__smart_read/);
  });

  it("passes through a small code Read (below denyThreshold)", async () => {
    const filePath = join(tempDir, "small.ts");
    await writeFile(filePath, "export const answer = 42;\n");

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    const { stdout, code } = await runHook(stdin, tempDir);

    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("passes through a non-code file (JSON config) regardless of size", async () => {
    const filePath = join(tempDir, "config.json");
    const payload = JSON.stringify(
      { entries: Array.from({ length: 1000 }, (_, i) => ({ id: i })) },
      null,
      2,
    );
    await writeFile(filePath, payload);

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    const { stdout, code } = await runHook(stdin, tempDir);

    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("passes through a bounded Read (offset or limit present)", async () => {
    const filePath = join(tempDir, "big.ts");
    await writeFile(
      filePath,
      Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n"),
    );

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath, offset: 100, limit: 50 },
    });

    const { stdout, code } = await runHook(stdin, tempDir);

    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("passes through a missing file (never blocks the agent)", async () => {
    const missing = join(tempDir, "does-not-exist.ts");

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: missing },
    });

    const { stdout, code } = await runHook(stdin, tempDir);

    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("records a telemetry entry in .token-pilot/hook-denied.jsonl when it denies", async () => {
    const filePath = join(tempDir, "big.ts");
    await writeFile(
      filePath,
      Array.from({ length: 500 }, (_, i) => `const c${i} = ${i};`).join("\n"),
    );

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await runHook(stdin, tempDir);

    const telemetryPath = join(tempDir, ".token-pilot", "hook-denied.jsonl");
    expect(existsSync(telemetryPath)).toBe(true);
    const entry = JSON.parse(readFileSync(telemetryPath, "utf-8").trim());
    expect(entry.filePath).toBe(filePath);
    expect(entry.mode).toBe("deny-enhanced");
    expect(entry.lineCount).toBeGreaterThan(300);
  });

  it('respects hooks.mode="off" from .token-pilot.json (no output at all)', async () => {
    const filePath = join(tempDir, "big.ts");
    await writeFile(
      filePath,
      Array.from({ length: 500 }, (_, i) => `const c${i} = ${i};`).join("\n"),
    );
    await writeFile(
      join(tempDir, ".token-pilot.json"),
      JSON.stringify({ hooks: { mode: "off" } }),
    );

    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    const { stdout, code } = await runHook(stdin, tempDir);

    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
