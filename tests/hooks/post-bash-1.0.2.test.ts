/**
 * 1.0.2 audit — hook-post-bash:
 *  - item 20: a large stderr (build errors) entered context unnoticed;
 *  - item 9: the default context-mode tool name was `execute` (it is
 *    `ctx_execute`), and the command path found context-mode only through
 *    `.mcp.json`, never as a plugin;
 *  - item 21: a stdout write that hit EAGAIN was logged as a hook error.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decidePostBashAdvice } from "../../src/hooks/post-bash.ts";
import { writeStdout } from "../../src/hooks/safe-runner.ts";

const BIG = "x".repeat(9000);

describe("post-bash advice", () => {
  it("counts stderr too", () => {
    const advice = decidePostBashAdvice({ tool_name: "Bash", tool_response: { stdout: "", stderr: BIG } });
    expect(advice.additionalContext).not.toBeNull();
  });

  it("names ctx_execute when context-mode is there but its tool name is unknown", () => {
    const advice = decidePostBashAdvice(
      { tool_name: "Bash", tool_response: { stdout: BIG } },
      { contextModeAvailable: true },
    );
    expect(advice.additionalContext).toContain("mcp__context-mode__ctx_execute");
  });
});

describe("hook-post-bash command path", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-post-bash-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("finds context-mode installed as a plugin", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "context-mode@context-mode": true } }),
    );
    const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: home };
    delete env.TOKEN_PILOT_MOD;

    const out = spawnSync("node", [resolve(__dirname, "../../dist/index.js"), "hook-post-bash"], {
      cwd: home,
      input: JSON.stringify({ tool_name: "Bash", tool_response: { stdout: BIG } }),
      encoding: "utf-8",
      env,
    }).stdout;

    expect(out).toContain("mcp__plugin_context-mode_context-mode__ctx_execute");
  });
});

describe("writeStdout", () => {
  const eagain = () => Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });

  it("retries a write the pipe was not ready for", () => {
    const chunks: string[] = [];
    let fails = 2;
    writeStdout("hello", (buf) => {
      if (fails-- > 0) throw eagain();
      chunks.push(buf.toString());
      return buf.length;
    });
    expect(chunks.join("")).toBe("hello");
  });

  it("gives up quietly when the pipe never drains", () => {
    expect(() =>
      writeStdout("hello", () => {
        throw eagain();
      }),
    ).not.toThrow();
  });

  it("finishes a partial write", () => {
    const chunks: string[] = [];
    writeStdout("hello", (buf) => {
      chunks.push(buf.subarray(0, 2).toString());
      return Math.min(2, buf.length);
    });
    expect(chunks.join("")).toBe("hello");
  });
});
