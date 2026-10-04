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

import type { EnforcementMode } from "../server/enforcement-mode.js";
import { toolPrefix } from "../core/tool-names.js";
import { isCodeFile } from "./read-gate.js";

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
  | { kind: "advise"; reason: string }
  | { kind: "deny"; reason: string };

/**
 * Shapes that look like TODO / FIXME / HACK / XXX / BUG tag scans —
 * route these to `code_audit` which returns deduplicated, categorised
 * results instead of N raw grep hits. Zero code_audit calls across three
 * projects (tool-audit 2026-04-24) = agents reach for Grep every time.
 */
export function isTodoScanPattern(pattern: string): boolean {
  // Strip common grep-alternation syntax to compare the symbol cores
  const normalised = pattern.replace(/[()\s]/g, "").toUpperCase();
  const tagRe =
    /^(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REFACTOR)(\|(TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REFACTOR))*$/;
  return tagRe.test(normalised);
}

/**
 * Heuristic: does `pattern` look like a code identifier worth sending
 * through find_usages?
 *
 * - Length ≥ 4 (avoid `id`, `err`, `db` — Grep wins there)
 * - No regex metacharacters (`.` `*` `+` `?` `|` `(` `)` `[` `]`
 *   `{` `}` `^` `$` `\`) — if present we assume real regex
 * - camelCase / PascalCase with an inner hump (`getUser`, `UserService`),
 *   snake_case or CONSTANT_CASE.
 *
 * Not identifiers (1.0.2): kebab-case (`token-pilot`, `x-api-key`,
 * `UTF-8` — package names, headers, CSS), a single capitalised word
 * (`Error`, `README`), anything starting with `-`.
 */
export function isSymbolLikePattern(pattern: string): boolean {
  if (pattern.length < 4) return false;

  // Regex metacharacters — if any present, assume user means regex.
  if (/[.*+?|()[\]{}^$\\]/.test(pattern)) return false;

  // A single word of letters, digits and underscores — no spaces, hyphens,
  // leading dashes.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern)) return false;
  if (!/[a-zA-Z]/.test(pattern)) return false;

  const hasUpperInMiddle = /[a-z0-9][A-Z]/.test(pattern);
  const hasUnderscore = /[A-Za-z0-9]_[A-Za-z0-9]/.test(pattern);

  return hasUpperInMiddle || hasUnderscore;
}

/** File types a Grep may be confined to that hold code. */
const CODE_TYPES = new Set([
  "js", "ts", "jsx", "tsx", "py", "rust", "go", "java", "kotlin", "swift",
  "php", "ruby", "c", "cpp", "csharp", "cs", "scala", "dart", "lua", "sh",
  "vue", "svelte", "sql", "elixir", "clojure", "elm", "ocaml", "fsharp",
]);

/** The search is confined to files that are not code (`*.md`, type md, a README). */
function nonCodeScope(input: PreGrepInput["tool_input"]): boolean {
  const glob = input?.glob;
  if (typeof glob === "string" && glob.length > 0) {
    return !globHasCode(glob);
  }

  const type = input?.type;
  if (typeof type === "string" && type.length > 0) return !CODE_TYPES.has(type.toLowerCase());

  const path = input?.path;
  return typeof path === "string" && /\.[A-Za-z0-9]+$/.test(path) && !isCodeFile(path);
}

/** `*.ts`, `src/**\/*.{ts,tsx}` — the glob names at least one code extension. */
function globHasCode(glob: string): boolean {
  const tail = glob.slice(glob.lastIndexOf(".") + 1).replace(/[{}]/g, "");

  return tail.split(",").some((ext) => isCodeFile(`x.${ext.trim()}`));
}

/**
 * Pure decision function. Given a PreToolUse hook input for Grep,
 * return whether to allow or deny (with a suggestion).
 */
export function decidePreGrep(
  input: PreGrepInput,
  mode: EnforcementMode = "deny",
): PreGrepDecision {
  if (input.tool_name !== "Grep") return { kind: "allow" };
  const pattern = input.tool_input?.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { kind: "allow" };
  }

  // TODO / FIXME / HACK tag scan → route to code_audit. Emitted as an
  // advisory ("allow" + hint) regardless of enforcement mode: blocking
  // would frustrate a legitimate one-off scan, but nudging the agent
  // toward code_audit compounds the benefit across a session.
  if (isTodoScanPattern(pattern)) {
    return {
      kind: "advise",
      reason:
        `Grep pattern "${pattern}" is a TODO / FIXME / HACK scan. ` +
        `Prefer ${toolPrefix()}code_audit(check="todo") — it returns deduplicated, ` +
        `categorised tags across the project with file/line references, ` +
        `typically 3-5× fewer tokens than raw Grep and ignores generated/` +
        `vendored code automatically.`,
    };
  }

  // Advisory mode disables the symbol-like deny (legacy behaviour).
  if (mode === "advisory") return { kind: "allow" };

  if (!isSymbolLikePattern(pattern)) return { kind: "allow" };

  // Bounded output (file names, counts, a head limit) or a search of
  // non-code files: Grep is the right tool.
  const ti = input.tool_input;
  const outputMode = ti?.output_mode;
  if (outputMode === "files_with_matches" || outputMode === "count") return { kind: "allow" };
  if (typeof ti?.head_limit === "number" && ti.head_limit > 0) return { kind: "allow" };
  if (nonCodeScope(ti)) return { kind: "allow" };

  const reason =
    `Grep pattern "${pattern}" looks like a code identifier. ` +
    `Use ${toolPrefix()}find_usages(symbol="${pattern}") for semantic ` +
    `search — groups results into definitions / imports / usages, typically ` +
    `5-10× cheaper than Grep's line-oriented output. ` +
    `Need a raw text search anyway (a string literal, a comment)? Bound it: ` +
    `output_mode "files_with_matches" or "count", or a head_limit.`;
  return { kind: "deny", reason };
}

/**
 * Render the Claude Code hook JSON response.
 */
export function renderPreGrepOutput(decision: PreGrepDecision): string | null {
  if (decision.kind === "allow") return null;
  if (decision.kind === "advise") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: decision.reason,
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}
