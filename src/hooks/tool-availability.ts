/**
 * Whether token-pilot's MCP tools are there in this session. A gate that
 * refuses Read or a shell read helps only when the model can call
 * smart_read instead; without the tools it costs a turn and names a tool
 * that does not exist. No Node here — the command hooks and the Claude Code
 * mod share it.
 */

import { join } from "../core/portable-path.js";

const TOOL_PREFIXES = ["mcp__plugin_token-pilot_token-pilot__", "mcp__token-pilot__"];

/** How /mcp records token-pilot's server as off: by its own name, or as the plugin's. */
const SERVER_NAMES = new Set(["token-pilot", "plugin:token-pilot:token-pilot"]);

/** The tool list holds token-pilot's tools, under either spelling. */
export function offersTokenPilot(tools: readonly string[]): boolean {
  return tools.some((tool) => TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix)));
}

/** Claude Code's per-project `disabledMcpServers` has token-pilot's server off. */
export function mcpDisabledInConfig(claudeJson: unknown, projectRoot: string): boolean {
  const projects = (claudeJson as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object") return false;

  const list = (projects as Record<string, { disabledMcpServers?: unknown } | undefined>)[projectRoot]
    ?.disabledMcpServers;

  return Array.isArray(list) && list.some((name) => SERVER_NAMES.has(String(name)));
}

/** Where Claude Code keeps per-project MCP state: `.claude.json` in its config dir, else in home. */
export function claudeJsonPath(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  const home = env.HOME ?? env.USERPROFILE;

  return home ? join(home, ".claude.json") : null;
}
