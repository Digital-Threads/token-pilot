/**
 * v0.26.3 — tool profiles. v0.28.1 — META_TOOLS always-available fix.
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
 * Three profiles, plus one always-on set:
 *   - META (implicit): always advertised, every profile — meta-tools
 *     the user needs to verify token-pilot is actually saving anything.
 *     Excluding them contradicts the whole point of profiles.
 *   - full (default): everything, same as pre-v0.26.3.
 *   - nav : META + read-only exploration (10 tools + META).
 *   - edit: META + nav + batch reads + edit-prep (16 tools + META).
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

/**
 * Meta-tools — diagnostic / self-observation tools that must be visible
 * in EVERY profile. Excluding them defeats the profile feature's own
 * purpose: if you can't check whether token-pilot is saving tokens, why
 * would you trust the savings number?
 */
export const META_TOOLS: ReadonlySet<string> = new Set([
  "session_analytics",
  "session_budget",
  "session_snapshot",
]);

/** Minimum nav profile — exploration only, no editing support. */
export const NAV_TOOLS: ReadonlySet<string> = new Set([
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
export const EDIT_EXTRAS: ReadonlySet<string> = new Set([
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
  // META_TOOLS are ALWAYS visible — session_analytics, session_budget,
  // session_snapshot are the instruments for verifying the profile is
  // doing its job. Hiding them would turn "did this save tokens?" into
  // a guess.
  if (profile === "nav") {
    return tools.filter((t) => NAV_TOOLS.has(t.name) || META_TOOLS.has(t.name));
  }
  // edit = nav + extras + meta
  return tools.filter(
    (t) =>
      NAV_TOOLS.has(t.name) ||
      EDIT_EXTRAS.has(t.name) ||
      META_TOOLS.has(t.name),
  );
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
