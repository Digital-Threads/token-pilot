/**
 * Tests for the ecosystem-check module.
 *
 * Covers: detection roundtrip via a temp HOME, rendering rules
 * (silent when empty, installed-only line, missing with hints),
 * and the exact format used by `token-pilot doctor`.
 */
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkEcosystem,
  formatEcosystemBlock,
  type EcosystemToolStatus,
} from "../../src/cli/ecosystem-check.ts";

function status(
  id: EcosystemToolStatus["id"],
  installed: boolean,
  name = id,
): EcosystemToolStatus {
  return {
    id,
    name,
    role: `${name} does X`,
    status: installed ? "installed" : "not-installed",
    detectedAt: installed ? `/fake/path/${name}` : null,
    installHint: `install ${name}`,
    repo: `https://example.com/${name}`,
  };
}

describe("formatEcosystemBlock", () => {
  it("returns null when no tools reported (empty array)", () => {
    expect(formatEcosystemBlock([])).toBeNull();
  });

  it("prints only installed tools with a check mark when nothing is missing", () => {
    const out = formatEcosystemBlock([
      status("caveman", true),
      status("context-mode", true),
      status("cavemem", true),
    ]);
    expect(out).not.toBeNull();
    expect(out).toContain("✓ caveman");
    expect(out).toContain("✓ context-mode");
    expect(out).toContain("✓ cavemem");
    expect(out).not.toContain("missing");
    expect(out).not.toContain("install:");
  });

  it("lists missing tools with install hints + ecosystem hint at the bottom", () => {
    const out = formatEcosystemBlock([
      status("caveman", false),
      status("context-mode", true),
      status("cavemem", false),
    ]);
    expect(out).toContain("✓ context-mode");
    expect(out).toContain("○ caveman");
    expect(out).toContain("missing");
    expect(out).toContain("install caveman");
    expect(out).toContain("install cavemem");
    // Closing guidance only appears when there's at least one gap
    expect(out).toContain("docs/ecosystem.md");
  });

  it("uses a header line readers will recognise as a doctor section", () => {
    const out = formatEcosystemBlock([status("caveman", false)]);
    expect(out?.startsWith("── ecosystem coverage ──")).toBe(true);
  });
});

describe("checkEcosystem — detection through a fake HOME", () => {
  const originalHome = process.env.HOME;
  const originalUserprofile = process.env.USERPROFILE;
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = join(tmpdir(), `tp-ecosystem-${process.pid}-${Date.now()}`);
    await mkdir(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("reports every tracked tool as not-installed against an empty HOME", () => {
    const statuses = checkEcosystem();
    expect(statuses.map((s) => s.id).sort()).toEqual(
      ["cavemem", "caveman", "context-mode"].sort(),
    );
    for (const s of statuses) {
      expect(s.status).toBe("not-installed");
      expect(s.detectedAt).toBeNull();
    }
  });

  it("detects caveman when its Claude Code plugin cache dir exists", async () => {
    const cavemanDir = join(fakeHome, ".claude", "plugins", "cache", "caveman");
    await mkdir(cavemanDir, { recursive: true });

    const statuses = checkEcosystem();
    const caveman = statuses.find((s) => s.id === "caveman");
    expect(caveman?.status).toBe("installed");
    expect(caveman?.detectedAt).toBe(cavemanDir);
  });

  it("detects caveman installed via Gemini extensions dir", async () => {
    const geminiDir = join(fakeHome, ".gemini", "extensions", "caveman");
    await mkdir(geminiDir, { recursive: true });

    const caveman = checkEcosystem().find((s) => s.id === "caveman");
    expect(caveman?.status).toBe("installed");
    expect(caveman?.detectedAt).toBe(geminiDir);
  });

  it("detects context-mode under either plugin name (context-mode or claude-context-mode)", async () => {
    // Test the alias path — the plugin is sometimes published as
    // `claude-context-mode` on npm but installed as `context-mode`.
    const aliasDir = join(
      fakeHome,
      ".claude",
      "plugins",
      "cache",
      "claude-context-mode",
    );
    await mkdir(aliasDir, { recursive: true });

    const cm = checkEcosystem().find((s) => s.id === "context-mode");
    expect(cm?.status).toBe("installed");
    expect(cm?.detectedAt).toBe(aliasDir);
  });

  it("includes meaningful install hints in every not-installed entry", () => {
    for (const s of checkEcosystem()) {
      expect(s.installHint.length, `id=${s.id}`).toBeGreaterThan(10);
      expect(s.repo, `id=${s.id}`).toMatch(/^https:\/\//);
    }
  });
});
