import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectDuplicateHookRegistrations } from "../../src/hooks/installer.js";

/**
 * v0.48.0 — a user who installed token-pilot by hand (npm + `install-hook`)
 * and later enabled the plugin ends up with BOTH registrations live. Claude
 * Code then runs every hook twice (or more, once per settings file), which
 * doubles the process spawns and double-counts the event log. `install-hook`
 * already refuses to add a second entry, but it never runs again for users
 * who installed before enabling the plugin — so the leftovers survive
 * silently. These tests cover the detector that surfaces them at bootstrap.
 */
describe("detectDuplicateHookRegistrations", () => {
  let tempDir: string;

  const tpCommand =
    "node /home/u/.nvm/versions/node/v22.16.0/lib/node_modules/token-pilot/dist/index.js hook-read";

  async function writeSettings(
    name: string,
    settings: unknown,
  ): Promise<string> {
    const dir = join(tempDir, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify(settings, null, 2));
    return path;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tp-dupe-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports nothing when given no paths", async () => {
    const report = await detectDuplicateHookRegistrations([]);
    expect(report.total).toBe(0);
    expect(report.sources).toEqual([]);
  });

  it("ignores a settings file that does not exist", async () => {
    const report = await detectDuplicateHookRegistrations([
      join(tempDir, "nope", "settings.json"),
    ]);
    expect(report.total).toBe(0);
  });

  it("ignores malformed JSON instead of throwing", async () => {
    const dir = join(tempDir, "broken");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    await writeFile(path, "not valid json{{{");

    const report = await detectDuplicateHookRegistrations([path]);
    expect(report.total).toBe(0);
  });

  it("counts token-pilot hook entries in a settings file", async () => {
    const path = await writeSettings("user", {
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: tpCommand }] },
          { matcher: "Edit", hooks: [{ type: "command", command: tpCommand }] },
        ],
      },
    });

    const report = await detectDuplicateHookRegistrations([path]);
    expect(report.total).toBe(2);
    expect(report.sources).toEqual([{ path, count: 2 }]);
  });

  it("does not count hooks belonging to other tools", async () => {
    const path = await writeSettings("other", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "task-journal ingest-hook" }] },
          { hooks: [{ type: "command", command: "ctx-mode-cache-heal.mjs" }] },
        ],
      },
    });

    const report = await detectDuplicateHookRegistrations([path]);
    expect(report.total).toBe(0);
    expect(report.sources).toEqual([]);
  });

  // cleanStaleHookEntries only scans PreToolUse/PostToolUse/SessionStart.
  // The real-world duplicate that produced double event-log rows lived in
  // SubagentStop, so the detector must cover every hook event.
  it("counts hooks under any event, including SubagentStop", async () => {
    const path = await writeSettings("all-events", {
      hooks: {
        SubagentStop: [
          { hooks: [{ type: "command", command: tpCommand }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: tpCommand }] },
        ],
      },
    });

    const report = await detectDuplicateHookRegistrations([path]);
    expect(report.total).toBe(2);
  });

  it("aggregates across several settings files, skipping clean ones", async () => {
    const userPath = await writeSettings("user", {
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: tpCommand }] },
        ],
      },
    });
    const cleanPath = await writeSettings("clean", { someOtherSetting: true });
    const projectPath = await writeSettings("project", {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: tpCommand }] },
          { matcher: "Task", hooks: [{ type: "command", command: tpCommand }] },
        ],
      },
    });

    const report = await detectDuplicateHookRegistrations([
      userPath,
      cleanPath,
      projectPath,
    ]);
    expect(report.total).toBe(3);
    expect(report.sources).toEqual([
      { path: userPath, count: 1 },
      { path: projectPath, count: 2 },
    ]);
  });

  it("deduplicates repeated paths so one file is never counted twice", async () => {
    const path = await writeSettings("user", {
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: tpCommand }] },
        ],
      },
    });

    const report = await detectDuplicateHookRegistrations([path, path]);
    expect(report.total).toBe(1);
    expect(report.sources).toHaveLength(1);
  });
});
