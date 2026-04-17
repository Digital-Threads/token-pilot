import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanAgents,
  classifyAgent,
  type ScannedAgent,
} from "../../src/cli/scan-agents.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-scan-test-"));
}

function agentMd(
  name: string,
  tools: string,
  description = "A test agent",
  extra = "",
): string {
  return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n${extra}---\n# ${name}\nBody content.\n`;
}

function agentMdList(
  name: string,
  toolsList: string[],
  description = "A test agent",
): string {
  const toolsYaml = toolsList.map((t) => `  - ${t}`).join("\n");
  return `---\nname: ${name}\ndescription: ${description}\ntools:\n${toolsYaml}\n---\n# ${name}\nBody content.\n`;
}

// ─── scanAgents ───────────────────────────────────────────────────────────────

describe("scanAgents", () => {
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("returns empty array when no agent directories exist", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: tmp,
      pluginCacheGlob: [],
    });
    expect(results).toEqual([]);
  });

  it("scans project .claude/agents/ directory for markdown files", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "my-agent.md"),
      agentMd("my-agent", "Read, Grep, Bash"),
    );

    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: join(tmp, "fakehome"),
      pluginCacheGlob: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("my-agent");
    expect(results[0].scope).toBe("project");
    expect(results[0].path).toBe(join(agentsDir, "my-agent.md"));
  });

  it("scans user ~/.claude/agents/ directory", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const homeAgentsDir = join(tmp, ".claude", "agents");
    await mkdir(homeAgentsDir, { recursive: true });
    await writeFile(
      join(homeAgentsDir, "user-agent.md"),
      agentMd("user-agent", "Read, Edit"),
    );

    const results = await scanAgents({
      projectRoot: join(tmp, "project"),
      homeDir: tmp,
      pluginCacheGlob: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("user-agent");
    expect(results[0].scope).toBe("user");
  });

  it("scans plugin cache directories when provided", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const pluginAgentsDir = join(tmp, "plugin1", "agents");
    await mkdir(pluginAgentsDir, { recursive: true });
    await writeFile(
      join(pluginAgentsDir, "plugin-agent.md"),
      agentMd("plugin-agent", "Read"),
    );

    const results = await scanAgents({
      projectRoot: join(tmp, "project"),
      homeDir: join(tmp, "home"),
      pluginCacheGlob: [join(pluginAgentsDir, "*.md")],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("plugin-agent");
    expect(results[0].scope).toBe("plugin");
  });

  it("skips files that fail to parse (returns one-line stderr note, never throws)", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "bad-agent.md"),
      "not a valid frontmatter file at all",
    );
    await writeFile(
      join(agentsDir, "good-agent.md"),
      agentMd("good-agent", "Read, Bash"),
    );

    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: join(tmp, "fakehome"),
      pluginCacheGlob: [],
    });

    // Should return just the good one
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("good-agent");
  });

  it("includes blessed field as true for files with token_pilot.blessed = true", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    const blessedMd = `---\nname: blessed-agent\ndescription: Blessed\ntools: Read, Bash, mcp__token-pilot__smart_read\ntoken_pilot:\n  blessed: true\n  upstream: user\n  blessed_at: "2026-01-01T00:00:00Z"\n  token_pilot_version: "0.20.0"\n  upstream_hash: abc123\n---\nBody\n`;
    await writeFile(join(agentsDir, "blessed-agent.md"), blessedMd);

    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: join(tmp, "fakehome"),
      pluginCacheGlob: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].blessed).toBe(true);
  });

  it("does not follow symlinks pointing outside the scope root", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });

    // Create an outside file and a symlink pointing to it
    const outsideDir = await makeTmpDir();
    tmpDirs.push(outsideDir);
    const outsideFile = join(outsideDir, "outside-agent.md");
    await writeFile(outsideFile, agentMd("outside-agent", "Read"));
    const symlinkPath = join(agentsDir, "symlinked.md");
    await symlink(outsideFile, symlinkPath);

    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: join(tmp, "fakehome"),
      pluginCacheGlob: [],
    });

    // Symlink pointing outside root should be skipped
    expect(results).toHaveLength(0);
  });

  it("includes bodyHash in scanned result", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "agent.md"),
      agentMd("agent", "Read, Bash"),
    );

    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: join(tmp, "fakehome"),
      pluginCacheGlob: [],
    });

    expect(results[0].bodyHash).toBeTruthy();
    expect(typeof results[0].bodyHash).toBe("string");
  });

  it("parses tools list (YAML array form)", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "list-agent.md"),
      agentMdList("list-agent", ["Read", "Bash", "Grep"]),
    );

    const results = await scanAgents({
      projectRoot: tmp,
      homeDir: join(tmp, "fakehome"),
      pluginCacheGlob: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].tools).toMatchObject({
      kind: "explicit",
      tools: ["Read", "Bash", "Grep"],
    });
  });
});

// ─── classifyAgent ────────────────────────────────────────────────────────────

describe("classifyAgent", () => {
  function makeAgent(tools: ScannedAgent["tools"]): ScannedAgent {
    return {
      name: "test",
      path: "/tmp/test.md",
      scope: "project",
      tools,
      description: "test agent",
      bodyHash: "abc",
      blessed: false,
    };
  }

  it("classifies wildcard tools as A", () => {
    const agent = makeAgent({ kind: "wildcard" });
    expect(classifyAgent(agent)).toBe("A");
  });

  it("classifies exclusion tools (without mcp__token-pilot__) as B", () => {
    const agent = makeAgent({ kind: "exclusion", excluded: ["Write", "Edit"] });
    expect(classifyAgent(agent)).toBe("B");
  });

  it("classifies explicit list without mcp__token-pilot__ as C", () => {
    const agent = makeAgent({
      kind: "explicit",
      tools: ["Read", "Bash", "Grep"],
    });
    expect(classifyAgent(agent)).toBe("C");
  });

  it("classifies explicit list that already has mcp__token-pilot__ as neither C (returns A)", () => {
    // Already blessed — has the MCP tools — treat as A since it has full access
    const agent = makeAgent({
      kind: "explicit",
      tools: ["Read", "Bash", "mcp__token-pilot__smart_read"],
    });
    // Already has mcp__token-pilot__* → not a C candidate
    expect(classifyAgent(agent)).toBe("A");
  });

  it("classifies exclusion that excludes mcp__token-pilot__ as C (needs blessing)", () => {
    const agent = makeAgent({
      kind: "exclusion",
      excluded: ["mcp__token-pilot__smart_read", "Write"],
    });
    expect(classifyAgent(agent)).toBe("C");
  });

  it("classifies empty tools list as C", () => {
    const agent = makeAgent({ kind: "explicit", tools: [] });
    expect(classifyAgent(agent)).toBe("C");
  });
});
