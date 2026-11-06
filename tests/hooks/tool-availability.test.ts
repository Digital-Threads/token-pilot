/**
 * A gate that refuses Read or a shell read helps only when the model can
 * call smart_read instead. Without token-pilot's tools it costs a turn and
 * names a tool that does not exist, so the gates step aside.
 */
import { describe, it, expect } from "vitest";
import {
  claudeJsonPath,
  mainCheckoutOf,
  mcpDisabledInConfig,
  offersTokenPilot,
} from "../../src/hooks/tool-availability.ts";

describe("offersTokenPilot", () => {
  it("finds the plugin's tools", () => {
    expect(offersTokenPilot(["Read", "mcp__plugin_token-pilot_token-pilot__smart_read"])).toBe(true);
  });

  it("finds the npm server's tools", () => {
    expect(offersTokenPilot(["mcp__token-pilot__smart_read"])).toBe(true);
  });

  it("finds nothing among other servers' tools", () => {
    expect(offersTokenPilot(["Read", "Bash", "mcp__plugin_context-mode_context-mode__ctx_execute"])).toBe(false);
  });
});

describe("mcpDisabledInConfig", () => {
  const config = (disabled: unknown) => ({ projects: { "/repo": { disabledMcpServers: disabled } } });

  it("is true when /mcp turned the server off by its own name", () => {
    expect(mcpDisabledInConfig(config(["context-mode", "token-pilot"]), ["/repo"])).toBe(true);
  });

  it("is true when /mcp turned the plugin's server off", () => {
    expect(mcpDisabledInConfig(config(["plugin:token-pilot:token-pilot"]), ["/repo"])).toBe(true);
  });

  it("is false for another project", () => {
    expect(mcpDisabledInConfig(config(["token-pilot"]), ["/other"])).toBe(false);
  });

  it("is false when other servers are off", () => {
    expect(mcpDisabledInConfig(config(["context-mode", "plugin:mempalace:mempalace"]), ["/repo"])).toBe(false);
  });

  it("is false for a config it cannot read", () => {
    expect(mcpDisabledInConfig(null, ["/repo"])).toBe(false);
    expect(mcpDisabledInConfig({ projects: { "/repo": { disabledMcpServers: "token-pilot" } } }, ["/repo"])).toBe(false);
  });
});

// Claude Code keys `projects` by the main checkout, with `/` separators:
// a worktree, a subfolder or a Windows path must still find its entry.
describe("mcpDisabledInConfig — the key Claude Code uses", () => {
  const off = (key: string) => ({ projects: { [key]: { disabledMcpServers: ["token-pilot"] } } });

  it("finds the entry under any of the candidate roots", () => {
    expect(mcpDisabledInConfig(off("/repo"), ["/repo/.worktrees/wt", "/repo"])).toBe(true);
  });

  it("matches across separators and a trailing slash", () => {
    expect(mcpDisabledInConfig(off("C:/Users/u/proj"), ["C:\\Users\\u\\proj\\"])).toBe(true);
  });
});

describe("mainCheckoutOf", () => {
  it("follows a worktree's .git file to the main checkout", () => {
    expect(mainCheckoutOf("/repo/.worktrees/wt", "gitdir: /repo/.git/worktrees/wt\n")).toBe("/repo");
  });

  it("resolves a relative gitdir against the worktree", () => {
    expect(mainCheckoutOf("/repo/.worktrees/wt", "gitdir: ../../.git/worktrees/wt\n")).toBe("/repo");
  });

  it("reads a Windows gitdir", () => {
    expect(mainCheckoutOf("C:/r/wt", "gitdir: C:/r/main/.git/worktrees/wt")).toBe("C:/r/main");
  });

  it("is null for a .git file that is not a worktree's", () => {
    expect(mainCheckoutOf("/repo/sub", "gitdir: /repo/.git/modules/sub")).toBeNull();
    expect(mainCheckoutOf("/repo", "not a gitdir line")).toBeNull();
  });
});

describe("claudeJsonPath", () => {
  it("lives in CLAUDE_CONFIG_DIR when it is set", () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/p/dt", HOME: "/home/u" })).toBe("/p/dt/.claude.json");
  });

  it("lives in the home directory otherwise", () => {
    expect(claudeJsonPath({ HOME: "/home/u" })).toBe("/home/u/.claude.json");
  });

  it("is unknown without either", () => {
    expect(claudeJsonPath({})).toBeNull();
  });
});
