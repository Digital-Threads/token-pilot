/**
 * Names around subagent dispatch, shared by the dispatch telemetry hooks.
 */

/**
 * The tool Claude Code dispatches subagents with. It was renamed from
 * `Task` to `Agent`, and `Task` survives only as a legacy alias, so a hook
 * can be handed either name.
 */
export function isDispatchTool(toolName: unknown): boolean {
  return toolName === "Agent" || toolName === "Task";
}

/**
 * Drop a plugin namespace from an agent type. Claude Code reports plugin
 * agents as `plugin:agent`; agent names cannot contain `:` themselves, so
 * the first colon is always the namespace separator.
 */
export function bareAgentName(agentType: string): string {
  return agentType.slice(agentType.indexOf(":") + 1);
}
