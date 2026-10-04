/**
 * Pieces of the session preamble shared by the SessionStart command hook and
 * the Claude Code mod's system-prompt section.
 */
import { describe, it, expect } from "vitest";
import {
  countTokenPilotHooks,
  duplicateWarning,
  snapshotLine,
} from "../../src/hooks/session-context.ts";

describe("snapshotLine", () => {
  it("points at a fresh snapshot with its goal", () => {
    const line = snapshotLine("# Snapshot\n**Goal:** ship the mod\n", 30 * 60_000);

    expect(line).toContain("session_snapshot from 30m ago");
    expect(line).toContain('goal: "ship the mod"');
  });

  it("ignores a snapshot older than two hours", () => {
    expect(snapshotLine("**Goal:** old", 3 * 3600_000)).toBeNull();
  });
});

describe("countTokenPilotHooks", () => {
  it("counts token-pilot hook commands in a settings object", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: "node /x/token-pilot/dist/index.js hook-read" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook" }] },
        ],
        SubagentStop: [{ hooks: [{ type: "command", command: "npx token-pilot hook-subagent-stop" }] }],
      },
    };

    expect(countTokenPilotHooks(settings)).toBe(2);
    expect(countTokenPilotHooks({})).toBe(0);
    expect(countTokenPilotHooks(null)).toBe(0);
  });
});

describe("duplicateWarning", () => {
  it("names the files and is silent when there are none", () => {
    expect(duplicateWarning([])).toBeNull();
    expect(duplicateWarning([{ path: "/h/.claude/settings.json", count: 9 }])).toContain(
      "registered 9 time(s) outside the plugin: /h/.claude/settings.json (9)",
    );
  });
});
