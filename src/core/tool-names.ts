/**
 * How this install's MCP tools are named to the model.
 *
 * A plugin exposes the server under the plugin namespace
 * (`mcp__plugin_token-pilot_token-pilot__smart_read`); an npm install
 * registered in `.mcp.json` exposes it bare (`mcp__token-pilot__smart_read`).
 * Advice that names the wrong one points the model at a tool that does not
 * exist on its install — and since Claude Code loads MCP definitions on
 * demand, it cannot even find the real one by searching for the name we
 * printed.
 *
 * v0.52.0 fixed this for the tools listed in agent frontmatter; the hook
 * messages kept naming the npm form, which is wrong for every plugin-only
 * user.
 */

const PLUGIN_PREFIX = "mcp__plugin_token-pilot_token-pilot__";
const NPM_PREFIX = "mcp__token-pilot__";

/** Full MCP name of one token-pilot tool, as this install exposes it. */
export function tpTool(name: string): string {
  return toolPrefix() + name;
}

/** The prefix alone — for messages that list several tools. */
export function toolPrefix(): string {
  return process.env.CLAUDE_PLUGIN_ROOT ? PLUGIN_PREFIX : NPM_PREFIX;
}

/**
 * Both spellings of one tool. Written into agent `tools:` lists, where the
 * name that does not resolve is ignored as long as another entry does.
 */
export function tpToolBothNames(name: string): string[] {
  return [NPM_PREFIX + name, PLUGIN_PREFIX + name];
}
