/**
 * SessionStart on Claude Code: the tools' own descriptions say when to use
 * them, so the model gets no rule block and no agent list here. It gets a
 * line only when a fresh snapshot is there to resume from. What the person
 * has to fix (a hook registered twice, old agent copies) goes to them as a
 * systemMessage, never into the model's context.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSessionStart } from "../../src/hooks/session-start.js";

const config = { enabled: true, showStats: false, maxReminderTokens: 500 };

/** A tp-*.md as `install-agents` wrote it before plugins existed. */
const LEGACY_AGENT =
  "---\nname: tp-run\ndescription: workhorse\ntools:\n  - mcp__token-pilot__smart_read\n  - Read\ntoken_pilot_body_hash: abc\n---\nbody\n";

/** The same agent as install-agents writes it today: both tool spellings. */
const CURRENT_AGENT =
  "---\nname: tp-run\ndescription: workhorse\ntools:\n  - mcp__token-pilot__smart_read\n  - mcp__plugin_token-pilot_token-pilot__smart_read\n---\nbody\n";

describe("handleSessionStart — Claude Code", () => {
  let dir: string;
  let project: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-session-test-"));
    project = join(dir, "project");
    home = join(dir, "home");
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const start = (extra: { pluginRoot?: string; userAgentsDir?: string } = {}) =>
    handleSessionStart({ projectRoot: project, homeDir: home, sessionStartConfig: config, ...extra });

  it("returns null when enabled=false", async () => {
    const out = await handleSessionStart({
      projectRoot: project,
      homeDir: home,
      sessionStartConfig: { ...config, enabled: false },
    });

    expect(out).toBeNull();
  });

  it("gives the model no tool rules and no agent list", async () => {
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await writeFile(join(project, ".claude", "agents", "tp-run.md"), CURRENT_AGENT);

    const payload = JSON.parse((await start())!).hookSpecificOutput;

    expect(payload.hookEventName).toBe("SessionStart");
    expect(payload.additionalContext).toBeUndefined();
  });

  it("keeps watchPaths", async () => {
    expect(JSON.parse((await start())!).hookSpecificOutput).toHaveProperty("watchPaths");
  });

  it("points the model at a fresh snapshot, and at nothing else", async () => {
    await mkdir(join(project, ".token-pilot", "snapshots"), { recursive: true });
    await writeFile(join(project, ".token-pilot", "snapshots", "latest.md"), "**Goal:** ship 1.0.6\n");

    const context = JSON.parse((await start())!).hookSpecificOutput.additionalContext as string;

    expect(context).toContain("ship 1.0.6");
    expect(context.split("\n")).toHaveLength(1);
  });

  it("tells the person, not the model, about old agent copies on a plugin install", async () => {
    const userAgents = join(home, ".claude", "agents");
    await mkdir(userAgents, { recursive: true });
    await writeFile(join(userAgents, "tp-run.md"), LEGACY_AGENT);
    await writeFile(join(userAgents, "tp-debugger.md"), LEGACY_AGENT.replace(/tp-run/g, "tp-debugger"));

    const out = JSON.parse((await start({ pluginRoot: join(dir, "plugin") }))!);

    expect(out.systemMessage).toContain(`2 old tp-*.md in ${userAgents}`);
    expect(out.systemMessage).toContain("npx token-pilot uninstall-agents --scope=user");
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it("reads the user agents from the folder Claude Code uses", async () => {
    const configAgents = join(dir, "profile", "agents");
    await mkdir(configAgents, { recursive: true });
    await writeFile(join(configAgents, "tp-run.md"), LEGACY_AGENT);

    const out = JSON.parse((await start({ pluginRoot: join(dir, "plugin"), userAgentsDir: configAgents }))!);

    expect(out.systemMessage).toContain(`1 old tp-*.md in ${configAgents}`);
  });

  it("leaves agent copies alone outside a plugin install, where they are the only ones", async () => {
    await mkdir(join(home, ".claude", "agents"), { recursive: true });
    await writeFile(join(home, ".claude", "agents", "tp-run.md"), LEGACY_AGENT);

    expect(JSON.parse((await start())!)).not.toHaveProperty("systemMessage");
  });

  it("does not count refreshed copies as old", async () => {
    await mkdir(join(home, ".claude", "agents"), { recursive: true });
    await writeFile(join(home, ".claude", "agents", "tp-run.md"), CURRENT_AGENT);

    expect(JSON.parse((await start({ pluginRoot: join(dir, "plugin") }))!)).not.toHaveProperty("systemMessage");
  });
});

// Codex validates the hook output and fails the hook on a key it does not
// know. Measured on Codex 0.156: with `watchPaths` present every session
// reports "SessionStart Failed"; the same payload without it completes.
describe("handleSessionStart — Codex", () => {
  it("keeps its tool text and drops watchPaths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tp-session-client-"));
    try {
      const out = await handleSessionStart({
        projectRoot: root,
        homeDir: join(root, "home"),
        sessionStartConfig: config,
        client: "codex",
      });

      const payload = JSON.parse(out!).hookSpecificOutput;
      expect(payload).not.toHaveProperty("watchPaths");
      expect(payload.additionalContext).toContain("smart_read");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
