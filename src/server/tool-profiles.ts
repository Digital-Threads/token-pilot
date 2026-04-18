/**
 * v0.26.3 — tool profiles.
 *
 * Idea lifted honestly from Token Savior's TOKEN_SAVIOR_PROFILE. When an
 * MCP server advertises 22 tools, every tools/list response costs the
 * agent ~3 k tokens before it does anything. Most sessions don't need
 * every tool — a code-review agent uses smart_read + find_usages +
 * outline and nothing else. A profile lets the user ship a narrower
 * tools/list while keeping the handlers live (so a subagent or another
 * user in the same server can still reach the full set if they know
 * the name).
 *
 * Three profiles:
 *   - full  (default): everything, same as pre-v0.26.3.
 *   - nav  : read-only exploration. smart_read, outline, find_usages,
 *            read_symbol, project_overview, module_info, related_files,
 *            explore_area, smart_log, smart_diff.
 *   - edit : nav + batch reads + everything Edit needs to hit a symbol
 *            precisely. Adds read_symbols, read_range, read_section,
 *            read_diff, read_for_edit, smart_read_many.
 *
 * Selection: TOKEN_PILOT_PROFILE=nav|edit|full env var. Unknown values
 * fall back to full with a stderr warning. Silent on missing env.
 */

export type ToolProfile = "full" | "nav" | "edit";

export const PROFILE_NAMES: readonly ToolProfile[] = [
  "full",
  "nav",
  "edit",
] as const;

/** Minimum nav profile — exploration only, no editing support. */
const NAV_TOOLS: ReadonlySet<string> = new Set([
  "smart_read",
  "read_symbol",
  "outline",
  "find_usages",
  "project_overview",
  "module_info",
  "related_files",
  "explore_area",
  "smart_log",
  "smart_diff",
]);

/** Edit profile adds batch reads + edit-preparation tools. */
const EDIT_EXTRAS: ReadonlySet<string> = new Set([
  "read_symbols",
  "read_range",
  "read_section",
  "read_diff",
  "read_for_edit",
  "smart_read_many",
]);

/**
 * Decide which tools the LLM sees in tools/list given a profile.
 * Pure — safe to unit-test without spinning up the server.
 *
 * Tool names NOT matched by any profile rule (e.g. future additions)
 * fall into 'full' only, to stay conservative by default.
 */
export function filterToolsByProfile<T extends { name: string }>(
  tools: readonly T[],
  profile: ToolProfile,
): T[] {
  if (profile === "full") return [...tools];
  if (profile === "nav") return tools.filter((t) => NAV_TOOLS.has(t.name));
  // edit = nav + extras
  return tools.filter((t) => NAV_TOOLS.has(t.name) || EDIT_EXTRAS.has(t.name));
}

/**
 * Parse the TOKEN_PILOT_PROFILE env value. Unknown values get a warning
 * and fall back to full — we never silently apply a guess.
 */
export function parseProfileEnv(
  envValue: string | undefined,
  warn: (msg: string) => void = () => {},
): ToolProfile {
  if (!envValue) return "full";
  const lower = envValue.trim().toLowerCase();
  if (lower === "full" || lower === "nav" || lower === "edit") {
    return lower;
  }
  warn(
    `[token-pilot] Unknown TOKEN_PILOT_PROFILE="${envValue}". Expected full|nav|edit. Falling back to full.`,
  );
  return "full";
}
