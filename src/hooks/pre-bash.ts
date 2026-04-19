/**
 * v0.28.0 — PreToolUse:Bash advisor / blocker.
 *
 * Intercepts heavy Bash commands BEFORE they run and redirects the
 * agent to cheaper alternatives. Why before? Claude Code's PostToolUse
 * hook cannot truncate the Bash `tool_response` (verified; the
 * updatedMCPToolOutput field is MCP-only). Post-factum advice means
 * the full stdout already sits in the agent's context. We save real
 * tokens only by refusing the heavy call up front.
 *
 * Patterns we block (in order, first match wins):
 *
 *  1. `grep -r <pattern>`         → suggest find_usages
 *  2. `find /` / `find ~`          → suggest Glob or bounded find
 *  3. `cat <code-file>`            → suggest smart_read
 *  4. `git log` without -n/-N      → suggest smart_log
 *  5. `git diff` without path      → suggest smart_diff
 *
 * For anything not matching → allow. We err on the side of false
 * negatives: a missed heavy command stays annoying (tokens wasted)
 * but a false-positive block blocks legitimate work and erodes trust.
 *
 * Strictly lexical — we don't shell-parse. Users running `grep` inside
 * `bash -c`, heredocs, or eval'd strings slip through. Acceptable for
 * v0.28.0; tighten only if tool-audit shows repeated escapes.
 */

export interface PreBashInput {
  tool_name?: string;
  tool_input?: {
    command?: string;
    [k: string]: unknown;
  };
}

export type PreBashDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

const CODE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|cpp|c|h|hpp|scala|clj|ex|exs|elm|ml|fs|dart|lua|sh|bash|zsh)(\s|$|;|\||&|>|<)/;

/** Check whether the command contains a specific utility invocation at
 *  top level (not inside a quoted string). Cheap lexical match. */
function invokes(command: string, utility: string): boolean {
  // Match `<utility> ` at start, after `; `, `&& `, `|| `, `| `, or newline.
  const re = new RegExp(`(^|[;&|\\n]\\s*)${utility}(\\s|$)`, "m");
  return re.test(command);
}

export function detectHeavyPattern(command: string): PreBashDecision {
  const cmd = command.trim();
  if (!cmd) return { kind: "allow" };

  // 1. grep -r / grep -R without -m and with a bareword pattern
  if (/\bgrep\s+[^|]*-[rR]\b/.test(cmd) && !/\s-m\s+\d+/.test(cmd)) {
    return {
      kind: "deny",
      reason:
        "Recursive `grep -r` can dump huge output into your context. " +
        "Use mcp__token-pilot__find_usages(symbol=...) for identifier searches " +
        "(semantic, grouped by definition/import/usage), or add `-m 20` to " +
        "bound the match count. Re-run through grep with `-m` to bypass.",
    };
  }

  // 2. find / | find ~ | find . without bounds
  if (/\bfind\s+(\/|~|\$HOME)/.test(cmd) && !/-maxdepth\s+\d+/.test(cmd)) {
    return {
      kind: "deny",
      reason:
        "Unbounded `find /` walks the whole filesystem and dumps every match. " +
        "Use the Glob tool for pattern matching, or add `-maxdepth N -type f -name <glob>` " +
        "to bound the walk. Re-run with `-maxdepth` to bypass.",
    };
  }

  // 3. cat <code-file> at top level
  if (invokes(cmd, "cat") && CODE_EXT_RE.test(cmd) && !cmd.includes("|")) {
    return {
      kind: "deny",
      reason:
        "`cat` on a code file dumps the whole thing into context. " +
        "Use mcp__token-pilot__smart_read(path) for a structural overview, " +
        "or Read(path, offset, limit) for a bounded slice. " +
        "For head/tail access use `head -n N` or `tail -n N`.",
    };
  }

  // 4. git log without -n / -N
  if (
    invokes(cmd, "git") &&
    /\bgit\s+log\b/.test(cmd) &&
    !/-n\s*\d+|-N\s*\d+|--max-count=\d+/.test(cmd) &&
    !/\|\s*head/.test(cmd)
  ) {
    return {
      kind: "deny",
      reason:
        "Unbounded `git log` can return thousands of commits. " +
        "Use mcp__token-pilot__smart_log for structured history, or add " +
        "`-n 20` / `| head -20` to bound. Re-run with a limit to bypass.",
    };
  }

  // 5. git diff with no path argument (common mistake on large repos)
  if (
    /\bgit\s+diff\b/.test(cmd) &&
    !/\bgit\s+diff\s+[^\s|]*--stat/.test(cmd) &&
    /\bgit\s+diff\s*($|[|;&])/.test(cmd)
  ) {
    return {
      kind: "deny",
      reason:
        "Bare `git diff` on a big working tree is huge. " +
        "Use mcp__token-pilot__smart_diff for per-symbol change summary, " +
        "or `git diff --stat` / `git diff <path>` to scope. Re-run scoped to bypass.",
    };
  }

  return { kind: "allow" };
}

export function decidePreBash(input: PreBashInput): PreBashDecision {
  if (input.tool_name !== "Bash") return { kind: "allow" };
  const cmd = input.tool_input?.command;
  if (typeof cmd !== "string") return { kind: "allow" };
  return detectHeavyPattern(cmd);
}

export function renderPreBashOutput(decision: PreBashDecision): string | null {
  if (decision.kind === "allow") return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}
