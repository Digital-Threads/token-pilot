import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loader.js";

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `tp-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeConfig(content: Record<string, unknown>) {
  await writeFile(join(testDir, ".token-pilot.json"), JSON.stringify(content));
}

describe("loadConfig — hooks.mode field (Phase 1 subtask 1.1/1.2)", () => {
  it('defaults hooks.mode to "deny-enhanced" when no config file exists', async () => {
    const cfg = await loadConfig(testDir);
    expect(cfg.hooks.mode).toBe("deny-enhanced");
  });

  it('defaults hooks.mode to "deny-enhanced" when config omits the field', async () => {
    await writeConfig({ hooks: { denyThreshold: 200 } });
    const cfg = await loadConfig(testDir);
    expect(cfg.hooks.mode).toBe("deny-enhanced");
    expect(cfg.hooks.denyThreshold).toBe(200);
  });

  it('respects explicit hooks.mode: "advisory"', async () => {
    await writeConfig({ hooks: { mode: "advisory" } });
    const cfg = await loadConfig(testDir);
    expect(cfg.hooks.mode).toBe("advisory");
  });

  it('respects explicit hooks.mode: "off"', async () => {
    await writeConfig({ hooks: { mode: "off" } });
    const cfg = await loadConfig(testDir);
    expect(cfg.hooks.mode).toBe("off");
  });

  it('respects explicit hooks.mode: "deny-enhanced"', async () => {
    await writeConfig({ hooks: { mode: "deny-enhanced" } });
    const cfg = await loadConfig(testDir);
    expect(cfg.hooks.mode).toBe("deny-enhanced");
  });

  it('migrates hooks.enabled:false to hooks.mode:"off" when mode is not explicitly set (v0.19 compat)', async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig({ hooks: { enabled: false } });

    const cfg = await loadConfig(testDir);

    expect(cfg.hooks.mode).toBe("off");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("hooks.enabled:false is deprecated"),
    );
    stderrSpy.mockRestore();
  });

  it("does NOT override explicit mode with enabled:false migration", async () => {
    await writeConfig({ hooks: { enabled: false, mode: "advisory" } });
    const cfg = await loadConfig(testDir);
    expect(cfg.hooks.mode).toBe("advisory");
  });

  it("warns and falls back to default when hooks.mode is unknown", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeConfig({ hooks: { mode: "hyperdrive" } });

    const cfg = await loadConfig(testDir);

    expect(cfg.hooks.mode).toBe("deny-enhanced");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown hooks.mode "hyperdrive"'),
    );
    stderrSpy.mockRestore();
  });
});
