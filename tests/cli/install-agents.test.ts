/**
 * Phase 5 subtasks 5.3 + 5.4 — install-agents tests.
 *
 * Covers scope resolution, fresh install, idempotence matrix
 * (unchanged-installed / template-upgraded / user-edited / no-hash),
 * --force override, and the required-scope contract for uninstall.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  installAgents,
  type InstallOptions,
} from "../../src/cli/install-agents.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-install-test-"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a fake dist/agents/<name>.md with the stamped frontmatter the
 * build script would emit: name, description, tools, token_pilot_version,
 * token_pilot_body_hash (sha256 of body only).
 */
async function writeFakeDistAgent(
  distDir: string,
  name: string,
  body = "Role: fake.\nResponse budget: ~100 tokens.\n",
  version = "0.20.0",
): Promise<string> {
  const hash = createHash("sha256").update(body).digest("hex");
  const content =
    `---\n` +
    `name: ${name}\n` +
    `description: Fake ${name}.\n` +
    `tools:\n  - Read\n  - mcp__token-pilot__smart_read\n` +
    `token_pilot_version: "${version}"\n` +
    `token_pilot_body_hash: ${hash}\n` +
    `---\n` +
    body;
  await writeFile(join(distDir, `${name}.md`), content);
  return content;
}

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ─── fresh install ───────────────────────────────────────────────────────────

describe("installAgents — fresh install", () => {
  it("writes all agents from distAgentsDir into scope=project target", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);

    await writeFakeDistAgent(dist, "tp-run");
    await writeFakeDistAgent(dist, "tp-onboard");

    const opts: InstallOptions = {
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    };
    const result = await installAgents(opts);

    expect(result.installed.sort()).toEqual(["tp-onboard", "tp-run"]);
    expect(result.targetDir).toBe(join(project, ".claude", "agents"));
    expect(await fileExists(join(result.targetDir, "tp-run.md"))).toBe(true);
    expect(await fileExists(join(result.targetDir, "tp-onboard.md"))).toBe(
      true,
    );
  });

  it("writes to ~/.claude/agents when scope=user", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const home = await makeTmp();
    tmpDirs.push(home);

    await writeFakeDistAgent(dist, "tp-run");

    const result = await installAgents({
      scope: "user",
      projectRoot: "/dev/null",
      homeDir: home,
      distAgentsDir: dist,
    });

    expect(result.targetDir).toBe(join(home, ".claude", "agents"));
    expect(await fileExists(join(result.targetDir, "tp-run.md"))).toBe(true);
  });

  it("creates the target dir if it does not exist", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    await writeFakeDistAgent(dist, "tp-run");

    const result = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });

    expect(result.installed).toEqual(["tp-run"]);
  });

  it("preserves frontmatter bytes from the dist source", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const original = await writeFakeDistAgent(dist, "tp-run");

    const result = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });

    const written = await readFile(
      join(result.targetDir, "tp-run.md"),
      "utf-8",
    );
    expect(written).toBe(original);
  });
});

// ─── idempotence ─────────────────────────────────────────────────────────────

describe("installAgents — idempotence", () => {
  it("unchanged-installed: re-install is silent, file bytes stay identical", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const original = await writeFakeDistAgent(dist, "tp-run");

    const first = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    const second = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });

    expect(first.installed).toEqual(["tp-run"]);
    expect(second.installed).toEqual([]);
    expect(
      second.skipped.some(
        (s) => s.name === "tp-run" && /unchanged/i.test(s.reason),
      ),
    ).toBe(true);
    const written = await readFile(join(first.targetDir, "tp-run.md"), "utf-8");
    expect(written).toBe(original);
  });

  it("unchanged-installed + --force: re-writes the file (v0.23.4 fix)", async () => {
    // Regression: before v0.23.4, --force on an unchanged file was a no-op.
    // That broke the common case of a frontmatter-only update (description
    // or tools changed, body unchanged → hash unchanged). --force must now
    // actually force a refresh.
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    await writeFakeDistAgent(dist, "tp-run");

    await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    // Re-run with --force on an unchanged file.
    const forced = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
      force: true,
    });
    expect(forced.installed).toEqual(["tp-run"]);
    expect(
      forced.skipped.some(
        (s) => s.name === "tp-run" && /unchanged/i.test(s.reason),
      ),
    ).toBe(false);
  });

  it("template-upgraded: stored hash differs, body matches stored → overwrite", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);

    // v1 template
    await writeFakeDistAgent(
      dist,
      "tp-run",
      "Role: v1 body.\nResponse budget: ~100 tokens.\n",
      "0.20.0",
    );
    const first = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    expect(first.installed).toEqual(["tp-run"]);

    // v2 template — different body → different hash
    await writeFakeDistAgent(
      dist,
      "tp-run",
      "Role: v2 body.\nResponse budget: ~200 tokens.\n",
      "0.20.1",
    );
    const second = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    expect(second.installed).toEqual(["tp-run"]);
    const written = await readFile(
      join(second.targetDir, "tp-run.md"),
      "utf-8",
    );
    expect(written).toContain("v2 body");
    expect(written).not.toContain("v1 body");
  });

  it("user-edited: body hash no longer matches → skip unless --force", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);

    await writeFakeDistAgent(dist, "tp-run");
    const first = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    expect(first.installed).toEqual(["tp-run"]);

    // User edits the installed agent body (frontmatter hash becomes stale)
    const target = join(first.targetDir, "tp-run.md");
    const edited = (await readFile(target, "utf-8")).replace(
      "Role: fake",
      "Role: user-customised",
    );
    await writeFile(target, edited);

    // Second install without --force → skip
    const second = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    expect(second.installed).toEqual([]);
    expect(
      second.skipped.some(
        (s) => s.name === "tp-run" && /edited by user/i.test(s.reason),
      ),
    ).toBe(true);
    const stillEdited = await readFile(target, "utf-8");
    expect(stillEdited).toContain("user-customised");

    // Third install with --force → overwrite
    const third = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
      force: true,
    });
    expect(third.installed).toEqual(["tp-run"]);
    const overwritten = await readFile(target, "utf-8");
    expect(overwritten).not.toContain("user-customised");
  });

  it("no-hash: user's own file without our marker is never touched", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);

    await writeFakeDistAgent(dist, "tp-run");

    // User wrote their own tp-run.md with no token_pilot_body_hash
    const userDir = join(project, ".claude", "agents");
    await mkdir(userDir, { recursive: true });
    const userContent = `---\nname: tp-run\ndescription: My own.\ntools: Read\n---\nMy body\n`;
    await writeFile(join(userDir, "tp-run.md"), userContent);

    const result = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    expect(result.installed).toEqual([]);
    expect(
      result.skipped.some(
        (s) =>
          s.name === "tp-run" &&
          /not .*installed by token-pilot/i.test(s.reason),
      ),
    ).toBe(true);
    const still = await readFile(join(userDir, "tp-run.md"), "utf-8");
    expect(still).toBe(userContent);
  });

  it("--force still skips a no-hash user file (never clobber user content)", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    await writeFakeDistAgent(dist, "tp-run");

    const userDir = join(project, ".claude", "agents");
    await mkdir(userDir, { recursive: true });
    const userContent = `---\nname: tp-run\ndescription: My own.\ntools: Read\n---\nMy body\n`;
    await writeFile(join(userDir, "tp-run.md"), userContent);

    const result = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
      force: true,
    });
    expect(result.installed).toEqual([]);
    const still = await readFile(join(userDir, "tp-run.md"), "utf-8");
    expect(still).toBe(userContent);
  });
});

// ─── empty / error paths ─────────────────────────────────────────────────────

describe("installAgents — edge cases", () => {
  it("returns empty when distAgentsDir has no tp-*.md files", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);

    const result = await installAgents({
      scope: "project",
      projectRoot: project,
      homeDir: "/dev/null",
      distAgentsDir: dist,
    });
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("throws a clear error when distAgentsDir does not exist", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    await expect(
      installAgents({
        scope: "project",
        projectRoot: project,
        homeDir: "/dev/null",
        distAgentsDir: "/no/such/dist",
      }),
    ).rejects.toThrow(/distAgentsDir/i);
  });
});
