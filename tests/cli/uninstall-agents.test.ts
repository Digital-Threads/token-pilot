/**
 * Phase 5 subtask 5.5 — uninstall-agents tests.
 *
 * Contract:
 *  - Removes only files whose frontmatter carries token_pilot_body_hash.
 *  - Never touches user-owned files (no marker).
 *  - Scope is required — no global default.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallAgents } from "../../src/cli/uninstall-agents.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-uninstall-test-"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function installedMd(name: string): string {
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: Installed ${name}.\n` +
    `tools:\n  - Read\n` +
    `token_pilot_version: "0.20.0"\n` +
    `token_pilot_body_hash: abc123def\n` +
    `---\n` +
    `Body\n`
  );
}

function userOwnedMd(name: string): string {
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: My own.\n` +
    `tools: Read\n` +
    `---\n` +
    `Custom\n`
  );
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("uninstallAgents", () => {
  it("removes files with token_pilot_body_hash marker in scope=project", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const dir = join(project, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tp-run.md"), installedMd("tp-run"));
    await writeFile(join(dir, "tp-onboard.md"), installedMd("tp-onboard"));

    const result = await uninstallAgents({
      scope: "project",
      projectRoot: project,
      homeDir: home,
    });
    expect(result.removed.sort()).toEqual(["tp-onboard", "tp-run"]);
    expect(await fileExists(join(dir, "tp-run.md"))).toBe(false);
    expect(await fileExists(join(dir, "tp-onboard.md"))).toBe(false);
  });

  it("removes files in scope=user from ~/.claude/agents", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const dir = join(home, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tp-run.md"), installedMd("tp-run"));

    const result = await uninstallAgents({
      scope: "user",
      projectRoot: project,
      homeDir: home,
    });
    expect(result.removed).toEqual(["tp-run"]);
    expect(await fileExists(join(dir, "tp-run.md"))).toBe(false);
  });

  it("never removes a file without token_pilot_body_hash (user-owned)", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);

    const dir = join(project, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tp-run.md"), userOwnedMd("tp-run"));

    const result = await uninstallAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toMatch(/not installed by token-pilot/i);
    expect(await fileExists(join(dir, "tp-run.md"))).toBe(true);
  });

  it("ignores files that are not tp-*.md", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);

    const dir = join(project, ".claude", "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "my-custom.md"), installedMd("my-custom"));
    await writeFile(join(dir, "tp-run.md"), installedMd("tp-run"));

    const result = await uninstallAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
    });
    expect(result.removed).toEqual(["tp-run"]);
    expect(await fileExists(join(dir, "my-custom.md"))).toBe(true);
    expect(await fileExists(join(dir, "tp-run.md"))).toBe(false);
  });

  it("returns empty when target directory does not exist", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const result = await uninstallAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
