/**
 * Tests for v0.42.0 `token-pilot install-statusline`.
 *
 * decideStatuslineAction is pure; handleInstallStatusline is exercised
 * against a tmp settings.json so the real ~/.claude is never touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decideStatuslineAction,
  handleInstallStatusline,
  classifyStatuslineAt,
  CHAIN_COMMAND,
  TP_ONLY_COMMAND,
} from "../../src/cli/install-statusline.ts";

const DEF = { force: false, chain: false };

describe("decideStatuslineAction (v0.42.3 — TP-only default)", () => {
  it("installs the TP-only badge when not configured", () => {
    const d = decideStatuslineAction("not-configured", DEF);
    expect(d.write).toBe(true);
    expect(d.result.action).toBe("installed");
    expect(d.command).toContain("tp-statusline.sh");
    expect(d.command).not.toContain("chain");
  });
  it("installs the chain only with --chain", () => {
    const d = decideStatuslineAction("not-configured", { force: false, chain: true });
    expect(d.write).toBe(true);
    expect(d.command).toContain("statusline-chain.sh");
  });
  it("switches an existing chain to TP-only by default (drops caveman badge)", () => {
    const d = decideStatuslineAction("configured-chain", DEF);
    expect(d.write).toBe(true);
    expect(d.command).toContain("tp-statusline.sh");
    expect(d.result.message).toMatch(/caveman badge removed/i);
  });
  it("no-ops when already TP-only (default)", () => {
    const d = decideStatuslineAction("configured-tp-only", DEF);
    expect(d.write).toBe(false);
    expect(d.result.action).toBe("noop");
  });
  it("no-ops when already chain and --chain requested", () => {
    const d = decideStatuslineAction("configured-chain", { force: false, chain: true });
    expect(d.write).toBe(false);
    expect(d.result.action).toBe("noop");
  });
  it("does NOT replace caveman-only without --force/--chain", () => {
    const d = decideStatuslineAction("configured-caveman-only", DEF);
    expect(d.write).toBe(false);
    expect(d.result.action).toBe("skipped");
  });
  it("upgrades caveman-only to chain with --chain (keeps both)", () => {
    const d = decideStatuslineAction("configured-caveman-only", { force: false, chain: true });
    expect(d.write).toBe(true);
    expect(d.command).toContain("statusline-chain.sh");
  });
  it("leaves a third-party statusLine alone without --force", () => {
    const d = decideStatuslineAction("configured-other", DEF);
    expect(d.write).toBe(false);
    expect(d.result.action).toBe("skipped");
    expect(d.result.message).toContain("--force");
  });
  it("replaces a third-party statusLine with --force (TP-only)", () => {
    const d = decideStatuslineAction("configured-other", { force: true, chain: false });
    expect(d.write).toBe(true);
    expect(d.command).toContain("tp-statusline.sh");
  });
  it("does not write on unknown (unparseable settings)", () => {
    expect(decideStatuslineAction("unknown", DEF).write).toBe(false);
  });
});

describe("classifyStatuslineAt", () => {
  let dir: string;
  let p: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-sl-"));
    p = join(dir, "settings.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("not-configured for missing file", async () => {
    expect(await classifyStatuslineAt(p)).toBe("not-configured");
  });
  it("not-configured when no statusLine key", async () => {
    await writeFile(p, JSON.stringify({ env: {} }));
    expect(await classifyStatuslineAt(p)).toBe("not-configured");
  });
  it("configured-chain for the chain wrapper", async () => {
    await writeFile(
      p,
      JSON.stringify({ statusLine: { command: "bash x/statusline-chain.sh" } }),
    );
    expect(await classifyStatuslineAt(p)).toBe("configured-chain");
  });
  it("configured-other for a custom command", async () => {
    await writeFile(
      p,
      JSON.stringify({ statusLine: { command: "my-own-badge.sh" } }),
    );
    expect(await classifyStatuslineAt(p)).toBe("configured-other");
  });
  it("unknown for invalid JSON", async () => {
    await writeFile(p, "{ not json");
    expect(await classifyStatuslineAt(p)).toBe("unknown");
  });
});

describe("handleInstallStatusline (tmp settings)", () => {
  let dir: string;
  let p: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outSpy: any;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-sl-h-"));
    p = join(dir, "settings.json");
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    outSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the TP-only command into a fresh settings file (default)", async () => {
    const code = await handleInstallStatusline([], { settingsPath: p });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(p, "utf-8"));
    expect(saved.statusLine.command).toBe(TP_ONLY_COMMAND);
    expect(saved.statusLine.command).not.toContain("chain");
    expect(saved.statusLine.type).toBe("command");
  });

  it("writes the chain command with --chain", async () => {
    await handleInstallStatusline(["--chain"], { settingsPath: p });
    const saved = JSON.parse(await readFile(p, "utf-8"));
    expect(saved.statusLine.command).toBe(CHAIN_COMMAND);
  });

  it("preserves existing settings keys when writing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(p, JSON.stringify({ env: { FOO: "1" }, model: "opus" }));
    await handleInstallStatusline([], { settingsPath: p });
    const saved = JSON.parse(await readFile(p, "utf-8"));
    expect(saved.env.FOO).toBe("1");
    expect(saved.model).toBe("opus");
    expect(saved.statusLine.command).toBe(TP_ONLY_COMMAND);
  });

  it("does NOT clobber a third-party statusLine without --force", async () => {
    await writeFile(
      p,
      JSON.stringify({ statusLine: { type: "command", command: "custom.sh" } }),
    );
    const code = await handleInstallStatusline([], { settingsPath: p });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(p, "utf-8"));
    expect(saved.statusLine.command).toBe("custom.sh"); // untouched
  });

  it("replaces a third-party statusLine with --force (TP-only)", async () => {
    await writeFile(
      p,
      JSON.stringify({ statusLine: { type: "command", command: "custom.sh" } }),
    );
    await handleInstallStatusline(["--force"], { settingsPath: p });
    const saved = JSON.parse(await readFile(p, "utf-8"));
    expect(saved.statusLine.command).toBe(TP_ONLY_COMMAND);
  });
});
