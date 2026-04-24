/**
 * Integration tests for the statusline badge scripts.
 *
 * These run the real bash scripts through child_process so the security
 * hardening (no shell injection, bounded read, whitelist sanitisation)
 * is exercised end-to-end. Vitest fake timers would miss the sed/awk
 * plumbing inside the scripts.
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const TP_SCRIPT = join(process.cwd(), "hooks", "tp-statusline.sh");
const CHAIN_SCRIPT = join(process.cwd(), "hooks", "statusline-chain.sh");

/** Run a bash script with optional stdin + env, return stdout. */
function runScript(
  script: string,
  input: string | null = null,
  env: NodeJS.ProcessEnv = {},
): string {
  const out = execFileSync("bash", [script], {
    input: input ?? "",
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 5000,
  });
  return out.toString();
}

/** Strip ANSI colour codes for cleaner assertions. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("tp-statusline.sh", () => {
  beforeEach(() => {
    // Make sure the scripts are executable even after fresh clone
    try {
      chmodSync(TP_SCRIPT, 0o755);
      chmodSync(CHAIN_SCRIPT, 0o755);
    } catch {
      /* ignore on CI runners without chmod perms */
    }
  });

  it("renders default badge [TP] with no stdin and no mode env", () => {
    const out = strip(runScript(TP_SCRIPT, ""));
    expect(out).toBe("[TP]");
  });

  it("renders [TP:strict] in strict mode", () => {
    const out = strip(runScript(TP_SCRIPT, "", { TOKEN_PILOT_MODE: "strict" }));
    expect(out).toBe("[TP:strict]");
  });

  it("renders [TP:advisory] in advisory mode", () => {
    const out = strip(
      runScript(TP_SCRIPT, "", { TOKEN_PILOT_MODE: "advisory" }),
    );
    expect(out).toBe("[TP:advisory]");
  });

  it("falls back to [TP] when TOKEN_PILOT_MODE is garbage (whitelist)", () => {
    const out = strip(
      runScript(TP_SCRIPT, "", { TOKEN_PILOT_MODE: "; rm -rf / ;" }),
    );
    expect(out).toBe("[TP]");
  });

  it("malformed stdin JSON still renders a clean badge", () => {
    const out = strip(runScript(TP_SCRIPT, "{not json"));
    expect(out).toBe("[TP]");
  });

  it("stdin past the 16KB cap is bounded (no buffer explosion)", () => {
    // 20KB — over the script's `head -c 16384` cap but small enough that
    // we don't race bash closing stdin while Node is still writing (EPIPE).
    // The guarantee under test is "bounded read", not "tolerate gigabyte
    // pipes gracefully" — the latter is Node's problem, not ours.
    const big = "a".repeat(20 * 1024);
    const out = strip(runScript(TP_SCRIPT, big));
    expect(out).toBe("[TP]");
  });

  it("shows cumulative savedTokens suffix when events file exists", async () => {
    const root = join(tmpdir(), `tp-statusline-${process.pid}-${Date.now()}`);
    await mkdir(join(root, ".token-pilot"), { recursive: true });
    const events = [
      '{"session_id":"sess-abc","savedTokens":5000,"ts":1714000000}',
      '{"session_id":"sess-abc","savedTokens":3500,"ts":1714000100}',
      '{"session_id":"OTHER","savedTokens":9999,"ts":1714000200}',
      '{"session_id":"sess-abc","savedTokens":2000,"ts":1714000300}',
    ].join("\n");
    await writeFile(join(root, ".token-pilot", "hook-events.jsonl"), events);

    const payload = JSON.stringify({
      session_id: "sess-abc",
      workspace: { current_dir: root },
    });
    const out = strip(runScript(TP_SCRIPT, payload));
    // 5000 + 3500 + 2000 = 10500 → "10k"
    expect(out).toMatch(/\[TP 10k\]/);

    await rm(root, { recursive: true, force: true });
  });

  it("ignores events for other sessions", async () => {
    const root = join(tmpdir(), `tp-statusline-${process.pid}-${Date.now()}-2`);
    await mkdir(join(root, ".token-pilot"), { recursive: true });
    await writeFile(
      join(root, ".token-pilot", "hook-events.jsonl"),
      '{"session_id":"other","savedTokens":99999}\n',
    );
    const payload = JSON.stringify({
      session_id: "me",
      workspace: { current_dir: root },
    });
    const out = strip(runScript(TP_SCRIPT, payload));
    // session "me" has no events → no saved suffix
    expect(out).toBe("[TP]");

    await rm(root, { recursive: true, force: true });
  });

  it("does not crash on malformed events.jsonl lines", async () => {
    const root = join(tmpdir(), `tp-statusline-${process.pid}-${Date.now()}-3`);
    await mkdir(join(root, ".token-pilot"), { recursive: true });
    const events = [
      "{not json",
      '{"session_id":"sess-x","savedTokens":"not a number"}',
      '{"session_id":"sess-x","savedTokens":500}',
      "",
    ].join("\n");
    await writeFile(join(root, ".token-pilot", "hook-events.jsonl"), events);

    const payload = JSON.stringify({
      session_id: "sess-x",
      workspace: { current_dir: root },
    });
    const out = strip(runScript(TP_SCRIPT, payload));
    expect(out).toMatch(/\[TP 500\]/);

    await rm(root, { recursive: true, force: true });
  });

  it("session_id with shell metacharacters is sanitised (no injection)", () => {
    // Feed a payload with backticks and $() — whitelist must strip them.
    const payload = JSON.stringify({
      session_id: "`whoami`",
      workspace: { current_dir: "/tmp" },
    });
    const out = strip(runScript(TP_SCRIPT, payload));
    // The whitelist (tr -cd a-zA-Z0-9-_) strips backticks → left with "whoami"
    // which doesn't match any events file, so we fall back to no-suffix badge.
    // The crucial guarantee: no execution of `whoami`.
    expect(out).toBe("[TP]");
    expect(out).not.toContain(process.env.USER ?? "unusedsentinel");
  });
});

describe("statusline-chain.sh", () => {
  it("renders at least the TP badge even when no other tools installed", () => {
    const out = strip(runScript(CHAIN_SCRIPT, ""));
    // The chain always falls back to the TP badge — caveman may or may
    // not be present on the test runner, so we just assert TP appears.
    expect(out).toContain("[TP");
  });

  it("handles empty stdin cleanly", () => {
    const out = strip(runScript(CHAIN_SCRIPT, ""));
    expect(out.length).toBeGreaterThan(0);
  });
});
