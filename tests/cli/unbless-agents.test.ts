import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unblessAgents,
  type UnblessOptions,
} from "../../src/cli/unbless-agents.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tp-unbless-test-"));
}

function blessedMd(name: string): string {
  return `---\nname: ${name}\ndescription: Agent\ntools:\n  - Read\n  - mcp__token-pilot__smart_read\ntoken_pilot:\n  blessed: true\n  upstream: user\n  blessed_at: "2026-01-01T00:00:00Z"\n  token_pilot_version: "0.20.0"\n  upstream_hash: abc123\n---\nBlessed body\n`;
}

function unblessedMd(name: string): string {
  return `---\nname: ${name}\ndescription: Agent\ntools: Read, Bash\n---\nCustom body\n`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── unblessAgents ────────────────────────────────────────────────────────────

describe("unblessAgents", () => {
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it("removes a blessed file by name", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "my-agent.md"), blessedMd("my-agent"));

    const opts: UnblessOptions = {
      projectRoot: tmp,
      names: ["my-agent"],
      all: false,
    };
    const summary = await unblessAgents(opts);

    expect(summary.removed).toBe(1);
    expect(await fileExists(join(agentsDir, "my-agent.md"))).toBe(false);
  });

  it("removes all blessed files when --all is set", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "agent-a.md"), blessedMd("agent-a"));
    await writeFile(join(agentsDir, "agent-b.md"), blessedMd("agent-b"));

    const opts: UnblessOptions = {
      projectRoot: tmp,
      names: [],
      all: true,
    };
    const summary = await unblessAgents(opts);

    expect(summary.removed).toBe(2);
    expect(await fileExists(join(agentsDir, "agent-a.md"))).toBe(false);
    expect(await fileExists(join(agentsDir, "agent-b.md"))).toBe(false);
  });

  it("never removes a file without the blessed marker", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "custom.md"), unblessedMd("custom"));

    const opts: UnblessOptions = {
      projectRoot: tmp,
      names: ["custom"],
      all: false,
    };
    const summary = await unblessAgents(opts);

    expect(summary.removed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(await fileExists(join(agentsDir, "custom.md"))).toBe(true);
  });

  it("skips names that don't exist in .claude/agents/", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });

    const opts: UnblessOptions = {
      projectRoot: tmp,
      names: ["nonexistent"],
      all: false,
    };
    const summary = await unblessAgents(opts);

    expect(summary.removed).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("only removes the named agent, not other blessed agents", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "agent-a.md"), blessedMd("agent-a"));
    await writeFile(join(agentsDir, "agent-b.md"), blessedMd("agent-b"));

    const opts: UnblessOptions = {
      projectRoot: tmp,
      names: ["agent-a"],
      all: false,
    };
    await unblessAgents(opts);

    expect(await fileExists(join(agentsDir, "agent-a.md"))).toBe(false);
    expect(await fileExists(join(agentsDir, "agent-b.md"))).toBe(true);
  });

  it("emits stderr summary line after removing", async () => {
    const tmp = await makeTmpDir();
    tmpDirs.push(tmp);
    const agentsDir = join(tmp, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "agent-a.md"), blessedMd("agent-a"));

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: any, ...args: any[]) => {
      stderrLines.push(String(s));
      return origWrite(s, ...args);
    };

    try {
      await unblessAgents({ projectRoot: tmp, names: ["agent-a"], all: false });
    } finally {
      process.stderr.write = origWrite;
    }

    const combined = stderrLines.join("");
    expect(combined).toMatch(/Unblessed 1 agent/i);
  });
});
