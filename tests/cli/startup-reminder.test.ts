/**
 * Phase 5 subtask 5.6 — MCP startup reminder tests.
 *
 * Reminder fires when: no tp-*.md exists in either user or project
 * scope AND agents.reminder is not false AND env suppress flags are
 * absent. Also exercises the single-fire guard.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldEmitStartupReminder,
  maybeEmitStartupReminder,
  _resetStartupReminderForTests,
  STARTUP_REMINDER_MESSAGE,
} from "../../src/cli/install-agents.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-reminder-test-"));
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

beforeEach(() => {
  _resetStartupReminderForTests();
});

describe("shouldEmitStartupReminder", () => {
  it("emits when nothing installed in either scope", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: false,
      env: {},
    });
    expect(result).toBe(true);
  });

  it("suppressed when a tp-* exists in project scope", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const dir = join(project, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tp-run.md"), "dummy");
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: false,
      env: {},
    });
    expect(result).toBe(false);
  });

  it("suppressed when a tp-* exists in user scope", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const dir = join(home, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tp-onboard.md"), "dummy");
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: false,
      env: {},
    });
    expect(result).toBe(false);
  });

  it("suppressed by agents.reminder=false (configSuppressed)", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: true,
      env: {},
    });
    expect(result).toBe(false);
  });

  it("suppressed by TOKEN_PILOT_NO_AGENT_REMINDER=1", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: false,
      env: { TOKEN_PILOT_NO_AGENT_REMINDER: "1" },
    });
    expect(result).toBe(false);
  });

  it("suppressed by TOKEN_PILOT_SUBAGENT=1", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: false,
      env: { TOKEN_PILOT_SUBAGENT: "1" },
    });
    expect(result).toBe(false);
  });

  it("non-tp- files in agents dir do not count as installed", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const dir = join(project, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "my-agent.md"), "dummy");
    const result = await shouldEmitStartupReminder({
      projectRoot: project,
      homeDir: home,
      configSuppressed: false,
      env: {},
    });
    expect(result).toBe(true);
  });
});

describe("maybeEmitStartupReminder — single-fire guard", () => {
  it("emits once, then returns false on subsequent calls", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;

    try {
      const first = await maybeEmitStartupReminder({
        projectRoot: project,
        homeDir: home,
        configSuppressed: false,
        env: {},
      });
      const second = await maybeEmitStartupReminder({
        projectRoot: project,
        homeDir: home,
        configSuppressed: false,
        env: {},
      });
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(captured.join("")).toContain(STARTUP_REMINDER_MESSAGE);
      // Only one emit total.
      expect(
        captured.filter((s) => s === STARTUP_REMINDER_MESSAGE).length,
      ).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("does not emit when suppressed", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;

    try {
      const emitted = await maybeEmitStartupReminder({
        projectRoot: project,
        homeDir: home,
        configSuppressed: true,
        env: {},
      });
      expect(emitted).toBe(false);
      expect(captured).toEqual([]);
    } finally {
      process.stderr.write = orig;
    }
  });
});
