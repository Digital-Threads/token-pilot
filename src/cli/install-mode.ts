/**
 * `token-pilot doctor` — how this token-pilot is installed. Run from a shell,
 * CLAUDE_PLUGIN_ROOT is unset even for a plugin install, so the script path
 * and the enabled-plugins list decide.
 */
export function describeInstallMode(opts: {
  pluginRoot?: string;
  scriptPath?: string;
  /** token-pilot@… is enabled in Claude Code settings. */
  pluginEnabled: boolean;
}): string {
  if (opts.pluginRoot) return `plugin (${opts.pluginRoot})`;

  const script = opts.scriptPath ?? "";
  const cached = script.match(/^(.*[\\/]plugins[\\/]cache[\\/]token-pilot[\\/]token-pilot[\\/][^\\/]+)[\\/]/);
  if (cached) return `plugin (${cached[1]})`;

  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(script)) return "dev / worktree (contributor)";

  if (opts.pluginEnabled) {
    return "npm / npx for this command; Claude Code itself runs the token-pilot plugin (enabled in settings)";
  }

  return "npm / npx";
}
