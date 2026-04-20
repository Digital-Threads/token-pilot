/**
 * v0.30.0 — TOKEN_PILOT_MODE enforcement modes.
 *
 * Controls how aggressively token-pilot blocks heavy native tools and
 * caps MCP tool output sizes. Three modes:
 *
 *   advisory  — hooks always allow, no MCP output caps. Observation-only.
 *               Use when measuring baseline token usage or debugging.
 *
 *   deny      — DEFAULT. Hooks deny heavy Bash/Grep patterns and suggest
 *               cheaper MCP alternatives. No auto-caps on MCP output.
 *               This is the "smart redirect" mode — the agent learns the
 *               right tool but can still produce large MCP responses.
 *
 *   strict    — deny + MCP output auto-caps. smart_read is capped at
 *               max_tokens=2000 when the caller doesn't set it; explore_area
 *               defaults include=['outline'] when the caller doesn't set it.
 *               Cap values are v0.30.0 initial estimates — tune from real
 *               tool-audit data in a follow-up PR (#8).
 *
 * Set via TOKEN_PILOT_MODE environment variable (case-insensitive, trimmed).
 * Unknown values fall back to "deny" with a warning.
 *
 * Separate from `hooks.mode` (HookMode) which controls only the PreToolUse:Read
 * hook (deny-enhanced vs advisory for large file reads). TOKEN_PILOT_MODE
 * covers Bash and Grep hooks plus MCP output caps.
 */

export type EnforcementMode = "advisory" | "deny" | "strict";
export const ENFORCEMENT_MODE_NAMES = [
  "advisory",
  "deny",
  "strict",
] as const satisfies readonly EnforcementMode[];

/**
 * Parse TOKEN_PILOT_MODE from an env-var string. Returns "deny" for
 * missing or empty values. Emits a warning for unrecognised values.
 */
export function parseEnforcementMode(
  raw: string | undefined,
  warn: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
): EnforcementMode {
  if (!raw || raw.trim() === "") return "deny";
  const v = raw.trim().toLowerCase();
  if (v === "advisory" || v === "deny" || v === "strict")
    return v as EnforcementMode;
  warn(
    `[token-pilot] Unknown TOKEN_PILOT_MODE="${raw}", falling back to "deny". ` +
      `Valid values: advisory | deny | strict.`,
  );
  return "deny";
}

/**
 * The cap applied to smart_read max_tokens in strict mode when the
 * caller has not supplied an explicit max_tokens.
 * v0.30.0 initial estimate — tune from tool-audit data.
 */
export const STRICT_SMART_READ_MAX_TOKENS = 2000;

/**
 * The include sections applied to explore_area in strict mode when the
 * caller has not supplied an explicit include array.
 * v0.30.0 initial estimate — outline-only keeps footprint minimal.
 */
export const STRICT_EXPLORE_AREA_INCLUDE: Array<
  "outline" | "imports" | "tests" | "changes"
> = ["outline"];
