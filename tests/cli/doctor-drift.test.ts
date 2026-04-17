import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDrift, formatDriftFinding } from "../../src/cli/doctor-drift.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-drift-test-"));
}

function blessedMd(opts: {
  name: string;
  upstream: "user" | "plugin";
  upstreamHash: string;
  body?: string;
}): string {
  return (
    `---\n` +
    `name: ${opts.name}\n` +
    `description: Test agent\n` +
    `tools:\n  - Read\n  - mcp__token-pilot__smart_read\n` +
    `token_pilot:\n` +
    `  blessed: true\n` +
    `  upstream: ${opts.upstream}\n` +
    `  blessed_at: "2026-01-01T00:00:00Z"\n` +
    `  token_pilot_version: "0.20.0"\n` +
    `  upstream_hash: ${opts.upstreamHash}\n` +
    `---\n` +
    (opts.body ?? "Blessed body") +
    `\n`
  );
}

function upstreamMd(name: string, body = "Upstream body"): string {
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: Upstream agent\n` +
    `tools: Read, Grep, Glob\n` +
    `---\n` +
    body +
    `\n`
  );
}

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("detectDrift", () => {
  it("returns empty findings when no blessed files exist", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);
    const findings = await detectDrift({ projectRoot: project, homeDir: home });
    expect(findings).toEqual([]);
  });

  it("returns empty findings when the upstream hash still matches", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    // Upstream in ~/.claude/agents
    const upstreamDir = join(home, ".claude", "agents");
    await mkdir(upstreamDir, { recursive: true });
    const upstreamContent = upstreamMd("demo");
    await writeFile(join(upstreamDir, "demo.md"), upstreamContent);

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(upstreamContent).digest("hex");

    // Blessed copy in <project>/.claude/agents with matching hash
    const blessedDir = join(project, ".claude", "agents");
    await mkdir(blessedDir, { recursive: true });
    await writeFile(
      join(blessedDir, "demo.md"),
      blessedMd({ name: "demo", upstream: "user", upstreamHash: hash }),
    );

    const findings = await detectDrift({ projectRoot: project, homeDir: home });
    expect(findings).toEqual([]);
  });

  it('reports "drifted" when upstream content has changed since bless', async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const upstreamDir = join(home, ".claude", "agents");
    await mkdir(upstreamDir, { recursive: true });
    // Upstream content is X
    await writeFile(
      join(upstreamDir, "demo.md"),
      upstreamMd("demo", "changed body"),
    );

    // Blessed copy records a stale hash that will not match current upstream
    const blessedDir = join(project, ".claude", "agents");
    await mkdir(blessedDir, { recursive: true });
    await writeFile(
      join(blessedDir, "demo.md"),
      blessedMd({ name: "demo", upstream: "user", upstreamHash: "stale_hash" }),
    );

    const findings = await detectDrift({ projectRoot: project, homeDir: home });
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("drifted");
    expect(findings[0].agentName).toBe("demo");
  });

  it('reports "missing-upstream" when the source file is gone', async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    // Only blessed copy exists — no upstream in home
    const blessedDir = join(project, ".claude", "agents");
    await mkdir(blessedDir, { recursive: true });
    await writeFile(
      join(blessedDir, "orphan.md"),
      blessedMd({ name: "orphan", upstream: "user", upstreamHash: "abc" }),
    );

    const findings = await detectDrift({ projectRoot: project, homeDir: home });
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("missing-upstream");
    expect(findings[0].agentName).toBe("orphan");
  });

  it("skips non-blessed files in .claude/agents/", async () => {
    const project = await makeTmp();
    tmpDirs.push(project);
    const home = await makeTmp();
    tmpDirs.push(home);

    const blessedDir = join(project, ".claude", "agents");
    await mkdir(blessedDir, { recursive: true });
    // User's own agent (no token_pilot marker) — must be ignored
    await writeFile(join(blessedDir, "custom.md"), upstreamMd("custom"));

    const findings = await detectDrift({ projectRoot: project, homeDir: home });
    expect(findings).toEqual([]);
  });

  it("never throws on filesystem errors — returns empty", async () => {
    const findings = await detectDrift({
      projectRoot: "/no/such/path",
      homeDir: "/no/such/home",
    });
    expect(findings).toEqual([]);
  });
});

describe("formatDriftFinding", () => {
  it("formats drifted findings with the re-bless hint", () => {
    const line = formatDriftFinding({
      agentName: "demo",
      blessedPath: "/x/demo.md",
      upstreamScope: "user",
      storedHash: "old",
      currentHash: "new",
      status: "drifted",
    });
    expect(line).toMatch(/upstream changed/);
    expect(line).toMatch(/bless-agents --re demo/);
  });

  it("formats missing-upstream findings with the unbless hint", () => {
    const line = formatDriftFinding({
      agentName: "orphan",
      blessedPath: "/x/orphan.md",
      upstreamScope: "user",
      storedHash: "old",
      currentHash: null,
      status: "missing-upstream",
    });
    expect(line).toMatch(/orphaned/);
    expect(line).toMatch(/unbless-agents orphan/);
  });
});
