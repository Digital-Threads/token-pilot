/**
 * v0.26.0 — AI-client detection tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectClient,
  nonClaudeClientWarning,
} from "../../src/cli/detect-client.ts";

let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "tp-home-"));
  tempProject = await mkdtemp(join(tmpdir(), "tp-proj-"));
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
  await rm(tempProject, { recursive: true, force: true });
});

describe("detectClient", () => {
  it("returns claude-code when CLAUDE_PLUGIN_ROOT is set", async () => {
    const r = await detectClient(tempHome, tempProject, {
      CLAUDE_PLUGIN_ROOT: "/some/path",
    });
    expect(r.client).toBe("claude-code");
    expect(r.subagentsSupported).toBe(true);
  });

  it("returns cursor when CURSOR_TRACE_ID is set", async () => {
    const r = await detectClient(tempHome, tempProject, {
      CURSOR_TRACE_ID: "abc",
    });
    expect(r.client).toBe("cursor");
    expect(r.subagentsSupported).toBe(false);
  });

  it("returns gemini when GEMINI_CLI is '1'", async () => {
    const r = await detectClient(tempHome, tempProject, { GEMINI_CLI: "1" });
    expect(r.client).toBe("gemini");
    expect(r.subagentsSupported).toBe(false);
  });

  it("returns codex when OPENAI_CODEX is '1'", async () => {
    const r = await detectClient(tempHome, tempProject, { OPENAI_CODEX: "1" });
    expect(r.client).toBe("codex");
    expect(r.subagentsSupported).toBe(false);
  });

  it("returns claude-code when ~/.claude/agents exists", async () => {
    await mkdir(join(tempHome, ".claude", "agents"), { recursive: true });
    const r = await detectClient(tempHome, tempProject, {});
    expect(r.client).toBe("claude-code");
    expect(r.source).toContain("~/.claude/agents");
  });

  it("returns cursor when project .cursor/ exists (no env vars)", async () => {
    await mkdir(join(tempProject, ".cursor"), { recursive: true });
    const r = await detectClient(tempHome, tempProject, {});
    expect(r.client).toBe("cursor");
    expect(r.subagentsSupported).toBe(false);
  });

  it("returns claude-code when both ~/.claude/ and .cursor/ exist (Claude wins by precedence)", async () => {
    await mkdir(join(tempHome, ".claude", "agents"), { recursive: true });
    await mkdir(join(tempProject, ".cursor"), { recursive: true });
    const r = await detectClient(tempHome, tempProject, {});
    expect(r.client).toBe("claude-code");
  });

  it("returns 'unknown' (subagents-assumed-supported) when no markers", async () => {
    const r = await detectClient(tempHome, tempProject, {});
    expect(r.client).toBe("unknown");
    expect(r.subagentsSupported).toBe(true);
  });
});

describe("nonClaudeClientWarning", () => {
  it("returns null for clients that support subagents", () => {
    const w = nonClaudeClientWarning({
      client: "claude-code",
      source: "env",
      subagentsSupported: true,
    });
    expect(w).toBeNull();
  });

  it("returns a warning mentioning the client and its source", () => {
    const w = nonClaudeClientWarning({
      client: "cursor",
      source: ".cursor/",
      subagentsSupported: false,
    });
    expect(w).toContain("cursor");
    expect(w).toContain(".cursor/");
    expect(w).toContain("Claude Code concept");
  });
});
