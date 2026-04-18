import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ─── agent-scanner ──────────────────────────────────────────────────────────

import { scanAgents } from "../../src/hooks/session-start.js";

describe("scanAgents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tp-agents-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty list when no agents dir exists", async () => {
    const result = await scanAgents(tempDir, join(tempDir, "no-home"));
    expect(result).toEqual([]);
  });

  it("returns empty list when agents dir exists but no tp-* files", async () => {
    await mkdir(join(tempDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "agents", "other.md"),
      "---\nname: other\n---\n# Other\n",
    );
    const result = await scanAgents(tempDir, join(tempDir, "no-home"));
    expect(result).toEqual([]);
  });

  it("parses a single tp-* agent with frontmatter", async () => {
    await mkdir(join(tempDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "agents", "tp-onboard.md"),
      "---\nname: tp-onboard\ndescription: Explore an unfamiliar repo\n---\n# Body\n",
    );
    const result = await scanAgents(tempDir, join(tempDir, "no-home"));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tp-onboard");
    expect(result[0].description).toBe("Explore an unfamiliar repo");
  });

  it("scans both project and home agent dirs and deduplicates by name", async () => {
    const fakeHome = join(tempDir, "home");
    await mkdir(join(tempDir, ".claude", "agents"), { recursive: true });
    await mkdir(join(fakeHome, ".claude", "agents"), { recursive: true });

    // Same name in both: project wins (project listed first, dedup keeps first)
    await writeFile(
      join(tempDir, ".claude", "agents", "tp-run.md"),
      "---\nname: tp-run\ndescription: Project version\n---\n",
    );
    await writeFile(
      join(fakeHome, ".claude", "agents", "tp-run.md"),
      "---\nname: tp-run\ndescription: Home version\n---\n",
    );
    // Unique to home
    await writeFile(
      join(fakeHome, ".claude", "agents", "tp-triage.md"),
      "---\nname: tp-triage\ndescription: Test triage\n---\n",
    );

    const result = await scanAgents(tempDir, fakeHome);
    expect(result).toHaveLength(2);
    const names = result.map((a) => a.name);
    expect(names).toContain("tp-run");
    expect(names).toContain("tp-triage");
    const runAgent = result.find((a) => a.name === "tp-run")!;
    expect(runAgent.description).toBe("Project version");
  });

  it("uses filename stem as name fallback when frontmatter name is absent", async () => {
    await mkdir(join(tempDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "agents", "tp-fallback.md"),
      "---\ndescription: Fallback desc\n---\n# Body\n",
    );
    const result = await scanAgents(tempDir, join(tempDir, "no-home"));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tp-fallback");
    expect(result[0].description).toBe("Fallback desc");
  });

  it("uses empty string for description when frontmatter description is absent", async () => {
    await mkdir(join(tempDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "agents", "tp-nodesc.md"),
      "---\nname: tp-nodesc\n---\n# Body\n",
    );
    const result = await scanAgents(tempDir, join(tempDir, "no-home"));
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("");
  });
});

// ─── message builder ─────────────────────────────────────────────────────────

import { buildReminderMessage } from "../../src/hooks/session-start.js";

describe("buildReminderMessage", () => {
  it("contains MANDATORY section", () => {
    const msg = buildReminderMessage([], 250);
    expect(msg).toContain("MANDATORY");
    expect(msg).toContain("mcp__token-pilot__smart_read");
  });

  it("contains WHEN DELEGATING section", () => {
    const msg = buildReminderMessage([], 250);
    expect(msg).toContain("WHEN DELEGATING");
  });

  it("shows install hint when no agents found", () => {
    const msg = buildReminderMessage([], 250);
    expect(msg).toContain("install-agents");
  });

  it("surfaces installed known agents via the decision guide", () => {
    const agents = [
      { name: "tp-run", description: "General workhorse" },
      { name: "tp-onboard", description: "Explore unfamiliar repo" },
    ];
    const msg = buildReminderMessage(agents, 400);
    expect(msg).toContain("tp-run");
    expect(msg).toContain("tp-onboard");
    // Known agents appear as task→name mappings, not descriptions
    expect(msg).toMatch(/→\s+tp-run/);
    expect(msg).toMatch(/→\s+tp-onboard/);
  });

  it("falls back to description for custom / non-core tp-* agents", () => {
    const agents = [
      { name: "tp-custom-widget", description: "Widget inspector" },
    ];
    const msg = buildReminderMessage(agents, 400);
    expect(msg).toContain("tp-custom-widget");
    expect(msg).toContain("Widget inspector");
  });

  it("hides decision-guide lines for agents that aren't installed", () => {
    // No agents installed → "none installed" + no decision-guide body
    const msg = buildReminderMessage([], 400);
    expect(msg).not.toMatch(/→\s+tp-/);
  });

  it('trims agent list with "… and N more" when over budget', () => {
    // Build many agents to force overflow
    const agents = Array.from({ length: 30 }, (_, i) => ({
      name: `tp-agent-${i}`,
      description: `Description for agent number ${i} which is quite long to inflate token count`,
    }));
    const msg = buildReminderMessage(agents, 250);
    expect(msg).toMatch(/… and \d+ more/);
  });

  it("fits within maxReminderTokens (250) with 0 agents", () => {
    const msg = buildReminderMessage([], 250);
    // Rough token estimate: chars/4
    const tokens = Math.ceil(msg.length / 4);
    expect(tokens).toBeLessThanOrEqual(250);
  });

  it("fits within maxReminderTokens (250) with 6 typical agents", () => {
    const agents = [
      { name: "tp-run", description: "General workhorse, MCP-first" },
      { name: "tp-onboard", description: "Exploring an unfamiliar repo" },
      { name: "tp-pr-reviewer", description: "Reviewing a diff or changeset" },
      { name: "tp-impact-analyzer", description: "Tracing what will break" },
      { name: "tp-refactor-planner", description: "Planning a refactor" },
      { name: "tp-test-triage", description: "Investigating test failures" },
    ];
    const msg = buildReminderMessage(agents, 250);
    const tokens = Math.ceil(msg.length / 4);
    expect(tokens).toBeLessThanOrEqual(250);
  });

  it("does NOT claim 'none installed' when all agents are trimmed due to budget (regression: show-stopper #1)", () => {
    // One agent with an absurdly long description that alone overflows any
    // reasonable budget. After trimming the only entry, the code must NOT
    // emit the install hint (that would falsely tell the agent there are
    // no subagents). It should report "… and N more" instead.
    const agents = [
      {
        name: "tp-fat",
        description:
          "This description is deliberately enormous: " +
          "lorem ipsum dolor sit amet ".repeat(80),
      },
    ];
    const msg = buildReminderMessage(agents, 250);
    expect(msg).not.toMatch(/none installed/);
    expect(msg).toMatch(/… and 1 more/);
  });

  it("still emits the install hint when the agent list is genuinely empty", () => {
    const msg = buildReminderMessage([], 250);
    expect(msg).toMatch(/none installed/);
  });
});

// ─── handleSessionStart handler ──────────────────────────────────────────────

import { handleSessionStart } from "../../src/hooks/session-start.js";

describe("handleSessionStart", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tp-session-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns JSON with additionalContext when enabled", async () => {
    const out = await handleSessionStart({
      projectRoot: tempDir,
      homeDir: join(tempDir, "home"),
      sessionStartConfig: {
        enabled: true,
        showStats: false,
        maxReminderTokens: 250,
      },
    });
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("MANDATORY");
  });

  it("returns null when enabled=false", async () => {
    const out = await handleSessionStart({
      projectRoot: tempDir,
      homeDir: join(tempDir, "home"),
      sessionStartConfig: {
        enabled: false,
        showStats: false,
        maxReminderTokens: 250,
      },
    });
    expect(out).toBeNull();
  });

  it("lists tp-* agents found in project agents dir", async () => {
    await mkdir(join(tempDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(tempDir, ".claude", "agents", "tp-run.md"),
      "---\nname: tp-run\ndescription: General workhorse\n---\n",
    );

    const out = await handleSessionStart({
      projectRoot: tempDir,
      homeDir: join(tempDir, "home"),
      sessionStartConfig: {
        enabled: true,
        showStats: false,
        maxReminderTokens: 250,
      },
    });
    const parsed = JSON.parse(out!);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("tp-run");
    // Known agents are surfaced as decision-guide task mappings
    expect(ctx).toMatch(/→\s+tp-run/);
  });

  it("shows install hint when no tp-* agents are present", async () => {
    const out = await handleSessionStart({
      projectRoot: tempDir,
      homeDir: join(tempDir, "home"),
      sessionStartConfig: {
        enabled: true,
        showStats: false,
        maxReminderTokens: 250,
      },
    });
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "install-agents",
    );
  });
});
