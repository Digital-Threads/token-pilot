/**
 * Phase 5 addendum — handleInstallAgents wrapper + scope persistence.
 *
 * The core installAgents() function is covered in install-agents.test.ts.
 * This file verifies the CLI-facing wrapper: flag parsing, TTY/non-TTY
 * behaviour, exit codes, and agents.scope persistence in
 * .token-pilot.json.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  handleInstallAgents,
  readPersistedScope,
  persistScope,
} from "../../src/cli/install-agents.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-install-cli-test-"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFakeDistAgent(distDir: string, name: string) {
  const body = `Role: fake.\nResponse budget: ~100 tokens.\n`;
  const hash = createHash("sha256").update(body).digest("hex");
  const content =
    `---\n` +
    `name: ${name}\n` +
    `description: Fake ${name}.\n` +
    `tools:\n  - Read\n` +
    `token_pilot_version: "0.20.0"\n` +
    `token_pilot_body_hash: ${hash}\n` +
    `---\n` +
    body;
  await writeFile(join(distDir, `${name}.md`), content);
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ─── flag parsing ────────────────────────────────────────────────────────────

describe("handleInstallAgents — arg parsing & scope resolution", () => {
  it("non-TTY without --scope returns exit 1", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents([], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(1);
    // Nothing was written.
    expect(
      await fileExists(join(project, ".claude", "agents", "tp-run.md")),
    ).toBe(false);
  });

  it("--scope=user writes into <homeDir>/.claude/agents", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents(["--scope=user"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(0);
    expect(await fileExists(join(home, ".claude", "agents", "tp-run.md"))).toBe(
      true,
    );
  });

  it("--scope=project writes into <projectRoot>/.claude/agents", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents(["--scope=project"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(0);
    expect(
      await fileExists(join(project, ".claude", "agents", "tp-run.md")),
    ).toBe(true);
  });

  it("--scope with invalid value returns exit 1", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents(["--scope=nope"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(1);
  });

  it("missing distAgentsDir returns exit 1", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const code = await handleInstallAgents(["--scope=project"], {
      isTTY: false,
      distAgentsDir: "/no/such/dir",
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(1);
  });
});

// ─── --force ────────────────────────────────────────────────────────────────

describe("handleInstallAgents — --force", () => {
  it("--force overwrites a user-edited installed agent", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    // First install.
    await handleInstallAgents(["--scope=project"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    const installedPath = join(project, ".claude", "agents", "tp-run.md");
    const original = await readFile(installedPath, "utf-8");

    // User edits.
    await writeFile(
      installedPath,
      original.replace("Role: fake", "Role: user-edit"),
    );

    // Re-install without --force — should not overwrite.
    await handleInstallAgents(["--scope=project"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(await readFile(installedPath, "utf-8")).toContain("user-edit");

    // --force overwrites.
    const code = await handleInstallAgents(["--scope=project", "--force"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(0);
    expect(await readFile(installedPath, "utf-8")).not.toContain("user-edit");
  });
});

// ─── persistence ─────────────────────────────────────────────────────────────

describe("agents.scope persistence", () => {
  it("persistScope + readPersistedScope round-trip", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    await persistScope(project, "user");
    expect(await readPersistedScope(project)).toBe("user");
    await persistScope(project, "project");
    expect(await readPersistedScope(project)).toBe("project");
  });

  it("persistScope merges with existing config fields", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    await writeFile(
      join(project, ".token-pilot.json"),
      JSON.stringify({ mode: "deny-enhanced", hooks: { denyThreshold: 300 } }),
    );
    await persistScope(project, "project");
    const raw = await readFile(join(project, ".token-pilot.json"), "utf-8");
    const cfg = JSON.parse(raw);
    expect(cfg.mode).toBe("deny-enhanced");
    expect(cfg.hooks.denyThreshold).toBe(300);
    expect(cfg.agents.scope).toBe("project");
  });

  it("readPersistedScope returns null when file missing", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    expect(await readPersistedScope(project)).toBeNull();
  });

  it("readPersistedScope returns null on malformed JSON", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    await writeFile(join(project, ".token-pilot.json"), "{not valid");
    expect(await readPersistedScope(project)).toBeNull();
  });

  it("handleInstallAgents writes agents.scope after successful install", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    await handleInstallAgents(["--scope=project"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(await readPersistedScope(project)).toBe("project");
  });

  it("handleInstallAgents uses persisted scope on re-run without flag (non-TTY)", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    // Pre-persist user scope.
    await persistScope(project, "user");

    // Non-TTY, no --scope — should use persisted `user`, not error.
    const code = await handleInstallAgents([], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
    });
    expect(code).toBe(0);
    expect(await fileExists(join(home, ".claude", "agents", "tp-run.md"))).toBe(
      true,
    );
    expect(
      await fileExists(join(project, ".claude", "agents", "tp-run.md")),
    ).toBe(false);
  });
});

// ─── v0.26.0 — non-Claude client detection ──────────────────────────────────

describe("handleInstallAgents — non-Claude client warning", () => {
  it("non-Claude client without --scope: warn and exit 0, no install", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents([], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
      env: { CURSOR_TRACE_ID: "abc" },
    });

    // Exit 0 (not an error, just "nothing to do for this client")
    expect(code).toBe(0);
    // No ghost directory created
    expect(await fileExists(join(home, ".claude", "agents", "tp-run.md"))).toBe(
      false,
    );
    expect(
      await fileExists(join(project, ".claude", "agents", "tp-run.md")),
    ).toBe(false);
  });

  it("non-Claude client WITH --scope=user: warn but proceed", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents(["--scope=user"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
      env: { CURSOR_TRACE_ID: "abc" },
    });

    // User forced install — should proceed despite warning
    expect(code).toBe(0);
    expect(await fileExists(join(home, ".claude", "agents", "tp-run.md"))).toBe(
      true,
    );
  });

  it("Claude Code (env) without --scope: install as usual", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    // Pre-persist so non-TTY path has a scope to pick
    await persistScope(project, "user");

    const code = await handleInstallAgents([], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
      env: { CLAUDE_PLUGIN_ROOT: "/some/path" },
    });

    expect(code).toBe(0);
    expect(await fileExists(join(home, ".claude", "agents", "tp-run.md"))).toBe(
      true,
    );
  });

  // v0.26.5 — plugin-aware note (CLAUDE_PLUGIN_ROOT set → note + still works)
  it("Claude Code plugin mode (CLAUDE_PLUGIN_ROOT set): installs normally with note", async () => {
    const dist = await makeTmp();
    tmpDirs.push(dist);
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    await writeFakeDistAgent(dist, "tp-run");

    const code = await handleInstallAgents(["--scope=user"], {
      isTTY: false,
      distAgentsDir: dist,
      projectRoot: project,
      homeDir: home,
      env: { CLAUDE_PLUGIN_ROOT: "/some/plugin/path" },
    });

    // Plugin mode should not block install — tp-* agents are separate
    // from plugin hooks.
    expect(code).toBe(0);
    expect(await fileExists(join(home, ".claude", "agents", "tp-run.md"))).toBe(
      true,
    );
  });
});
