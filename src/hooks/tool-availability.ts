/**
 * Whether token-pilot's MCP tools are there in this session. A gate that
 * refuses Read or a shell read helps only when the model can call
 * smart_read instead; without the tools it costs a turn and names a tool
 * that does not exist. No Node here — the command hooks and the Claude Code
 * mod share it.
 */

import { isAbsolute, join, normalize } from "../core/portable-path.js";

const TOOL_PREFIXES = ["mcp__plugin_token-pilot_token-pilot__", "mcp__token-pilot__"];

/** How /mcp records token-pilot's server as off: by its own name, or as the plugin's. */
const SERVER_NAMES = new Set(["token-pilot", "plugin:token-pilot:token-pilot"]);

/** The tool list holds token-pilot's tools, under either spelling. */
export function offersTokenPilot(tools: readonly string[]): boolean {
  return tools.some((tool) => TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix)));
}

/** A path as Claude Code writes a `projects` key: `/` separators, no trailing slash. */
function projectKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
}

/**
 * Claude Code's per-project `disabledMcpServers` has token-pilot's server
 * off. `roots` are the candidate keys — the session's folder, its checkout
 * and, for a linked worktree, the main checkout, which is where Claude Code
 * keeps the entry for every worktree of a repository.
 */
export function mcpDisabledInConfig(claudeJson: unknown, roots: readonly string[]): boolean {
  const projects = (claudeJson as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object") return false;

  const wanted = new Set(roots.map(projectKey));

  return Object.entries(projects as Record<string, { disabledMcpServers?: unknown } | null>).some(
    ([key, entry]) =>
      wanted.has(projectKey(key)) &&
      Array.isArray(entry?.disabledMcpServers) &&
      entry.disabledMcpServers.some((name) => SERVER_NAMES.has(String(name))),
  );
}

/**
 * The main checkout a linked worktree belongs to, from the worktree's `.git`
 * file (`gitdir: <main>/.git/worktrees/<name>`); null for any other `.git` file.
 */
export function mainCheckoutOf(checkout: string, gitFile: string): string | null {
  const line = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
  if (!line) return null;

  const gitdir = isAbsolute(line[1]) ? line[1] : normalize(join(checkout, line[1]));
  const main = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);

  return main ? main[1] : null;
}

/** Where Claude Code keeps per-project MCP state: `.claude.json` in its config dir, else in home. */
export function claudeJsonPath(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  const home = env.HOME ?? env.USERPROFILE;

  return home ? join(home, ".claude.json") : null;
}
