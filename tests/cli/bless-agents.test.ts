import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blessAgent,
  blessAll,
  type BlessOptions,
} from "../../src/cli/bless-agents.js";
import { parseFrontmatter } from "../../src/cli/agent-frontmatter.js";
import type { ScannedAgent } from "../../src/cli/scan-agents.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-bless-test-"));
}

function makeScannedAgent(overrides: Partial<ScannedAgent> = {}): ScannedAgent {
  return {
    name: "acc-test-agent",
    path: "/fake/upstream/.claude/agents/acc-test-agent.md",
    scope: "user",
    tools: { kind: "explicit", tools: ["Read", "Bash", "Grep"] },
    description: "A test agent for ddd auditing",
    bodyHash: "abc123",
    blessed: false,
    ...overrides,
  };
}

// ─── blessAgent ───────────────────────────────────────────────────────────────

describe("blessAgent", () => {
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("writes a blessed file to .claude/agents/<name>.md in project root", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);

    const upstreamBody = "# acc-test-agent\nThis is the upstream body.\n";
    const upstreamDir = join(tmp, "upstream");
    await mkdir(upstreamDir, { recursive: true });
    const upstreamPath = join(upstreamDir, "acc-test-agent.md");
    await writeFile(
      upstreamPath,
      `---\nname: acc-test-agent\ndescription: A test agent\ntools: Read, Bash\n---\n${upstreamBody}`,
    );

    const agent = makeScannedAgent({ path: upstreamPath });
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: false,
    };

    const result = await blessAgent(agent, opts);

    expect(result.kind).toBe("blessed");
    const destPath = join(tmp, ".claude", "agents", "acc-test-agent.md");
    const content = await readFile(destPath, "utf-8");
    const { meta, body } = parseFrontmatter(content);

    // Check token_pilot block
    expect(meta.token_pilot).toBeTruthy();
    expect(meta.token_pilot.blessed).toBe(true);
    expect(meta.token_pilot.token_pilot_version).toBe("0.20.0");
    expect(meta.token_pilot.upstream_hash).toBeTruthy();
    expect(meta.token_pilot.blessed_at).toBeTruthy();

    // Check tools extended with all 6 mcp tools
    const tools: string[] = Array.isArray(meta.tools) ? meta.tools : [];
    expect(tools).toContain("mcp__token-pilot__smart_read");
    expect(tools).toContain("mcp__token-pilot__read_symbol");
    expect(tools).toContain("mcp__token-pilot__read_for_edit");
    expect(tools).toContain("mcp__token-pilot__outline");
    expect(tools).toContain("mcp__token-pilot__find_usages");
    expect(tools).toContain("mcp__token-pilot__explore_area");

    // Original tools preserved
    expect(tools).toContain("Read");
    expect(tools).toContain("Bash");

    // Body copied from upstream
    expect(body).toContain("upstream body");
  });

  it("writes blessed_at as a valid ISO date string", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const upstreamPath = join(tmp, "acc-test-agent.md");
    await writeFile(
      upstreamPath,
      `---\nname: acc-test-agent\ndescription: Test\ntools: Read\n---\nBody\n`,
    );
    const agent = makeScannedAgent({ path: upstreamPath });
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: false,
    };

    await blessAgent(agent, opts);
    const destPath = join(tmp, ".claude", "agents", "acc-test-agent.md");
    const { meta } = parseFrontmatter(await readFile(destPath, "utf-8"));
    const date = new Date(meta.token_pilot.blessed_at);
    expect(isNaN(date.getTime())).toBe(false);
  });

  it("returns skipped when destination already exists with blessed:true and force=false", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    const destPath = join(agentsDir, "acc-test-agent.md");
    // Write existing blessed file
    await writeFile(
      destPath,
      `---\nname: acc-test-agent\ntools: Read, Bash, mcp__token-pilot__smart_read\ntoken_pilot:\n  blessed: true\n---\nExisting body\n`,
    );

    const upstreamPath = join(tmp, "upstream.md");
    await writeFile(
      upstreamPath,
      `---\nname: acc-test-agent\ntools: Read\n---\nBody\n`,
    );
    const agent = makeScannedAgent({ path: upstreamPath });
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: false,
    };

    const result = await blessAgent(agent, opts);
    expect(result.kind).toBe("skipped");
    expect(result.reason).toMatch(/already blessed/i);
  });

  it("overwrites when destination has blessed:true and force=true", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    const destPath = join(agentsDir, "acc-test-agent.md");
    await writeFile(
      destPath,
      `---\nname: acc-test-agent\ntools: Read\ntoken_pilot:\n  blessed: true\n---\nOld body\n`,
    );

    const upstreamPath = join(tmp, "upstream.md");
    await writeFile(
      upstreamPath,
      `---\nname: acc-test-agent\ntools: Read\n---\nNew upstream body\n`,
    );
    const agent = makeScannedAgent({ path: upstreamPath });
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: true,
      dryRun: false,
    };

    const result = await blessAgent(agent, opts);
    expect(result.kind).toBe("blessed");
    const content = await readFile(destPath, "utf-8");
    expect(content).toContain("New upstream body");
  });

  it("skips (with warning) when destination exists without blessed marker (user prior customisation)", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    const destPath = join(agentsDir, "acc-test-agent.md");
    // Existing file without blessed marker = user's prior customisation
    await writeFile(
      destPath,
      `---\nname: acc-test-agent\ntools: Read, Bash\n---\nCustom body\n`,
    );

    const upstreamPath = join(tmp, "upstream.md");
    await writeFile(
      upstreamPath,
      `---\nname: acc-test-agent\ntools: Read\n---\nBody\n`,
    );
    const agent = makeScannedAgent({ path: upstreamPath });
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: false,
    };

    const result = await blessAgent(agent, opts);
    expect(result.kind).toBe("skipped");
    expect(result.reason).toMatch(/prior customis/i);
  });

  it("returns dry-run result without writing file when dryRun=true", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const upstreamPath = join(tmp, "agent.md");
    await writeFile(
      upstreamPath,
      `---\nname: acc-test-agent\ntools: Read\n---\nBody\n`,
    );
    const agent = makeScannedAgent({ path: upstreamPath });
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: true,
    };

    const result = await blessAgent(agent, opts);
    expect(result.kind).toBe("dry-run");

    // Destination should NOT exist
    const destPath = join(tmp, ".claude", "agents", "acc-test-agent.md");
    let exists = false;
    try {
      await readFile(destPath);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

// ─── blessAll ────────────────────────────────────────────────────────────────

describe("blessAll", () => {
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("blesses all provided Category-C agents and returns summary", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);

    // Create two upstream agent files
    for (const name of ["agent-one", "agent-two"]) {
      await writeFile(
        join(tmp, `${name}.md`),
        `---\nname: ${name}\ndescription: Agent\ntools: Read\n---\nBody\n`,
      );
    }

    const agents = [
      makeScannedAgent({ name: "agent-one", path: join(tmp, "agent-one.md") }),
      makeScannedAgent({ name: "agent-two", path: join(tmp, "agent-two.md") }),
    ];

    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: false,
    };

    const summary = await blessAll(agents, opts);
    expect(summary.blessed).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it("emits stderr notice with count after blessing", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    await writeFile(
      join(tmp, "agent-one.md"),
      `---\nname: agent-one\ntools: Read\n---\nBody\n`,
    );

    const agents = [
      makeScannedAgent({ name: "agent-one", path: join(tmp, "agent-one.md") }),
    ];
    const opts: BlessOptions = {
      projectRoot: tmp,
      tokenPilotVersion: "0.20.0",
      force: false,
      dryRun: false,
    };

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: any, ...args: any[]) => {
      stderrLines.push(String(s));
      return origWrite(s, ...args);
    };

    try {
      await blessAll(agents, opts);
    } finally {
      process.stderr.write = origWrite;
    }

    const combined = stderrLines.join("");
    expect(combined).toMatch(/Blessed 1 agent/i);
    expect(combined).toMatch(/new Claude Code session/i);
  });
});
