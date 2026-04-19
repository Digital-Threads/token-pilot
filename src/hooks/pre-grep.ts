/**
 * v0.28.0 — PreToolUse:Grep advisor / blocker.
 *
 * When the main-thread agent uses Grep to search for a symbol-like
 * identifier (camelCase, snake_case, PascalCase, ≥4 chars, no regex
 * metacharacters) we suggest `mcp__token-pilot__find_usages` instead.
 * The MCP tool does semantic search — groups results into definitions /
 * imports / usages — and for real symbols is 5-10× cheaper than Grep's
 * line-oriented output.
 *
 * For anything that LOOKS like regex (special chars, quantifiers,
 * alternation) or short generic terms (≤3 chars) we allow Grep through
 * unchanged. Those are cases where semantic search doesn't apply or
 * Grep is genuinely cheaper.
 *
 * This is strictly advisory in the v0.28.0 first pass: we emit
 * permissionDecision: "deny" so the agent sees the suggestion on the
 * first attempt, but the user mandate is passive-as-possible — if
 * adoption data (tool-audit) shows agents actually re-run through
 * find_usages after the block, we keep it. If they bypass via `-E` or
 * raw shell, we soften to advisory.
 */

export interface PreGrepInput {
  tool_name?: string;
  tool_input?: {
    pattern?: string;
    path?: string;
    type?: string;
    [k: string]: unknown;
  };
}

export type PreGrepDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

/**
 * Heuristic: does `pattern` look like a code identifier worth sending
 * through find_usages?
 *
 * - Length ≥ 4 (avoid `id`, `err`, `db` — Grep wins there)
 * - No regex metacharacters (`.` `*` `+` `?` `|` `(` `)` `[` `]`
 *   `{` `}` `^` `$` `\`) — if present we assume real regex
 * - Not purely lowercase words (those look like prose search)
 * - Matches `camelCase`, `PascalCase`, `snake_case`, `CONSTANT_CASE`,
 *   or `kebab-case` shapes
 */
export function isSymbolLikePattern(pattern: string): boolean {
  if (pattern.length < 4) return false;

  // Regex metacharacters — if any present, assume user means regex.
  if (/[.*+?|()[\]{}^$\\]/.test(pattern)) return false;

  // Spaces or control chars — not a single symbol.
  if (/\s/.test(pattern)) return false;

  // Must contain at least one letter (so "12345" or "-->" don't trip).
  if (!/[a-zA-Z]/.test(pattern)) return false;

  // Shapes we consider symbol-like:
  //   camelCase        → foo(Bar)+
  //   PascalCase       → (Foo)+
  //   snake_case       → at least one underscore
  //   CONSTANT_CASE    → all upper with underscore
  //   kebab-case       → at least one hyphen
  const hasUpperInMiddle = /[a-z][A-Z]/.test(pattern);
  const hasUnderscore = /_/.test(pattern);
  const hasHyphen = /-/.test(pattern);
  const isPureUppercase = /^[A-Z][A-Z0-9]+$/.test(pattern);
  const isPascalCase = /^[A-Z][a-zA-Z0-9]+$/.test(pattern);

  return (
    hasUpperInMiddle ||
    hasUnderscore ||
    hasHyphen ||
    isPureUppercase ||
    isPascalCase
  );
}

/**
 * Pure decision function. Given a PreToolUse hook input for Grep,
 * return whether to allow or deny (with a suggestion).
 */
export function decidePreGrep(input: PreGrepInput): PreGrepDecision {
  if (input.tool_name !== "Grep") return { kind: "allow" };
  const pattern = input.tool_input?.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { kind: "allow" };
  }
  if (!isSymbolLikePattern(pattern)) return { kind: "allow" };

  const reason =
    `Grep pattern "${pattern}" looks like a code identifier. ` +
    `Use mcp__token-pilot__find_usages(symbol="${pattern}") for semantic ` +
    `search — groups results into definitions / imports / usages, typically ` +
    `5-10× cheaper than Grep's line-oriented output. ` +
    `If you really need a raw text search (regex, comment hunt, string ` +
    `literal) re-run Grep with -E or a regex-shaped pattern to bypass.`;
  return { kind: "deny", reason };
}

/**
 * Render the Claude Code hook JSON response.
 */
export function renderPreGrepOutput(decision: PreGrepDecision): string | null {
  if (decision.kind === "allow") return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}
