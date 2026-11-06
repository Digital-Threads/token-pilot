/**
 * A gate that refuses Read or a shell read helps only when the model can
 * call smart_read instead. Without token-pilot's tools it costs a turn and
 * names a tool that does not exist, so the gates step aside.
 */
import { describe, it, expect } from "vitest";
import {
  claudeJsonPath,
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
    expect(mcpDisabledInConfig(config(["context-mode", "token-pilot"]), "/repo")).toBe(true);
  });

  it("is true when /mcp turned the plugin's server off", () => {
    expect(mcpDisabledInConfig(config(["plugin:token-pilot:token-pilot"]), "/repo")).toBe(true);
  });

  it("is false for another project", () => {
    expect(mcpDisabledInConfig(config(["token-pilot"]), "/other")).toBe(false);
  });

  it("is false when other servers are off", () => {
    expect(mcpDisabledInConfig(config(["context-mode", "plugin:mempalace:mempalace"]), "/repo")).toBe(false);
  });

  it("is false for a config it cannot read", () => {
    expect(mcpDisabledInConfig(null, "/repo")).toBe(false);
    expect(mcpDisabledInConfig({ projects: { "/repo": { disabledMcpServers: "token-pilot" } } }, "/repo")).toBe(false);
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
