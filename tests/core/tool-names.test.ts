/**
 * Hook advice has to name the tool the reader can actually call. A plugin
 * install exposes the MCP server under the plugin namespace; an npm install
 * exposes it bare. Naming the wrong one sends the model after a tool that
 * does not exist on its install.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  tpTool,
  toolPrefix,
  tpToolBothNames,
} from "../../src/core/tool-names.ts";

const saved = process.env.CLAUDE_PLUGIN_ROOT;

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = saved;
});

describe("tpTool", () => {
  it("uses the plugin namespace when running as a plugin", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/home/me/.claude/plugins/cache/tp/tp/1";

    expect(tpTool("smart_read")).toBe(
      "mcp__plugin_token-pilot_token-pilot__smart_read",
    );
    expect(toolPrefix()).toBe("mcp__plugin_token-pilot_token-pilot__");
  });

  it("uses the bare name for an npm install", () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;

    expect(tpTool("smart_read")).toBe("mcp__token-pilot__smart_read");
    expect(toolPrefix()).toBe("mcp__token-pilot__");
  });
});

describe("tpToolBothNames", () => {
  it("lists both spellings regardless of how this process runs", () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/somewhere";

    expect(tpToolBothNames("outline")).toEqual([
      "mcp__token-pilot__outline",
      "mcp__plugin_token-pilot_token-pilot__outline",
    ]);
  });
});
