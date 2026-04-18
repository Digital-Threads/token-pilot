/**
 * Phase 6 subtask 6.4 — legacy `mode: "deny"` migration tests.
 *
 * On load, if the user's .token-pilot.json has `mode: "deny"` (the v0.19
 * legacy value, removed in v0.20 per TP-816 §7.1), the loader rewrites
 * it to `mode: "advisory"` and stamps `migratedFrom: "deny"` so the
 * one-time stderr notice does not re-fire on subsequent loads.
 *
 * Covered:
 *  - Migration happens exactly once (idempotence)
 *  - Other config fields are preserved
 *  - Non-"deny" configs are left untouched
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loader.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-migration-test-"));
}

async function readCfg(dir: string): Promise<Record<string, any>> {
  const raw = await readFile(join(dir, ".token-pilot.json"), "utf-8");
  return JSON.parse(raw);
}

const tmpDirs: string[] = [];
const stderrSaves: Array<{ orig: typeof process.stderr.write }> = [];

afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
  for (const s of stderrSaves) process.stderr.write = s.orig;
  stderrSaves.length = 0;
});

function captureStderr(): string[] {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  stderrSaves.push({ orig });
  process.stderr.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  // Also intercept console.error which loader uses.
  const origErr = console.error;
  const origOrig = orig;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" ") + "\n");
  };
  stderrSaves.push({
    orig: ((...args: unknown[]) => {
      console.error = origErr;
      return origOrig(...(args as [string])) as boolean;
    }) as unknown as typeof process.stderr.write,
  });
  return lines;
}

describe("legacy hooks.mode:deny migration", () => {
  it("rewrites mode:deny → mode:advisory on first load and stamps migratedFrom", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".token-pilot.json"),
      JSON.stringify({
        hooks: { mode: "deny", denyThreshold: 150 },
      }),
    );

    const stderr = captureStderr();
    const cfg = await loadConfig(dir);
    expect(cfg.hooks.mode).toBe("advisory");

    const persisted = await readCfg(dir);
    expect(persisted.hooks.mode).toBe("advisory");
    expect(persisted.hooks.migratedFrom).toBe("deny");
    expect(persisted.hooks.denyThreshold).toBe(150);

    const combined = stderr.join("");
    expect(combined).toMatch(/migrated.*deny.*advisory/i);
  });

  it("is idempotent: second load does not re-emit the notice", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".token-pilot.json"),
      JSON.stringify({
        hooks: { mode: "deny", denyThreshold: 200 },
      }),
    );

    // First load — should migrate + notice.
    await loadConfig(dir);

    // Second load — file already has mode:advisory + migratedFrom:deny.
    const stderr2 = captureStderr();
    const cfg2 = await loadConfig(dir);
    expect(cfg2.hooks.mode).toBe("advisory");
    expect(stderr2.join("")).not.toMatch(/migrated/i);
  });

  it("preserves other top-level config fields when rewriting", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".token-pilot.json"),
      JSON.stringify({
        hooks: { mode: "deny" },
        sessionStart: { enabled: false, showStats: true },
        agents: { scope: "user" },
      }),
    );

    captureStderr();
    await loadConfig(dir);
    const persisted = await readCfg(dir);

    expect(persisted.hooks.mode).toBe("advisory");
    expect(persisted.sessionStart.enabled).toBe(false);
    expect(persisted.sessionStart.showStats).toBe(true);
    expect(persisted.agents.scope).toBe("user");
  });

  it("leaves non-legacy configs untouched (no migratedFrom stamp)", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".token-pilot.json"),
      JSON.stringify({ hooks: { mode: "advisory" } }),
    );

    captureStderr();
    await loadConfig(dir);
    const persisted = await readCfg(dir);

    expect(persisted.hooks.mode).toBe("advisory");
    expect(persisted.hooks.migratedFrom).toBeUndefined();
  });

  it("leaves mode:off untouched", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    await writeFile(
      join(dir, ".token-pilot.json"),
      JSON.stringify({ hooks: { mode: "off" } }),
    );
    captureStderr();
    const cfg = await loadConfig(dir);
    expect(cfg.hooks.mode).toBe("off");
    const persisted = await readCfg(dir);
    expect(persisted.hooks.migratedFrom).toBeUndefined();
  });
});
