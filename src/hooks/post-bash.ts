/**
 * TP-jzh — Bash output advisor.
 *
 * Claude Code's PostToolUse hook cannot modify or truncate `tool_response`
 * (verified via Claude Code docs 2026-04-18 — the `updatedMCPToolOutput`
 * field is MCP-only). The agent has already seen the full stdout by the
 * time our hook fires.
 *
 * So the feature becomes an *advisory*: when Bash stdout is large, we
 * append one line via `additionalContext` pointing the agent at cheaper
 * alternatives (`mcp__token-pilot__test_summary` for tests, bounded
 * commands, head/tail piping). The agent notices before it repeats the
 * mistake on the next turn.
 */

export interface PostBashHookInput {
  tool_name?: string;
  tool_response?: unknown;
}

export interface PostBashAdvice {
  /** Null when no advice is needed. */
  additionalContext: string | null;
  /** For telemetry: approximate output size the advisor saw. */
  outputChars: number;
}

const LARGE_OUTPUT_THRESHOLD_CHARS = 8000;

function extractStdout(tool_response: unknown): string {
  if (!tool_response) return "";
  if (typeof tool_response === "string") return tool_response;
  if (typeof tool_response === "object") {
    const r = tool_response as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["stdout", "output", "content"]) {
      const v = r[key];
      if (typeof v === "string") parts.push(v);
    }
    return parts.join("\n");
  }
  return "";
}

function countLines(s: string): number {
  if (s === "") return 0;
  return s.split(/\r?\n/).length;
}

/**
 * Pure decision function. Given a PostToolUse hook input for the Bash
 * tool, return advice text (or null to stay silent).
 */
export interface PostBashAdviceOptions {
  thresholdChars?: number;
  /**
   * When true, the advice also mentions context-mode — runs the command
   * in a sandbox so only stdout enters context. Caller detects whether
   * context-mode is installed and passes the flag.
   */
  contextModeAvailable?: boolean;
}

export function decidePostBashAdvice(
  input: PostBashHookInput,
  thresholdCharsOrOpts:
    | number
    | PostBashAdviceOptions = LARGE_OUTPUT_THRESHOLD_CHARS,
): PostBashAdvice {
  const opts: PostBashAdviceOptions =
    typeof thresholdCharsOrOpts === "number"
      ? { thresholdChars: thresholdCharsOrOpts }
      : thresholdCharsOrOpts;
  const threshold = opts.thresholdChars ?? LARGE_OUTPUT_THRESHOLD_CHARS;

  if (input.tool_name !== "Bash") {
    return { additionalContext: null, outputChars: 0 };
  }
  const stdout = extractStdout(input.tool_response);
  const chars = stdout.length;
  if (chars < threshold) {
    return { additionalContext: null, outputChars: chars };
  }
  const lines = countLines(stdout);
  const roughTokens = Math.ceil(chars / 4);
  const contextModeLine = opts.contextModeAvailable
    ? " Or run via mcp__context-mode__execute — sandbox keeps stdout out of your window."
    : "";
  const msg =
    `⚠ Bash output was large (~${lines} lines, ~${roughTokens} tokens). ` +
    `Consider mcp__token-pilot__test_summary for test runs, or bounded commands ` +
    `(head/tail, --oneline, git log -n <N>, grep -m <N>) to keep context lean.` +
    contextModeLine;
  return { additionalContext: msg, outputChars: chars };
}

/**
 * Render the JSON payload Claude Code expects. Returns null for silent
 * pass-through so the caller can simply `exit(0)` with no stdout.
 */
export function renderPostBashHookOutput(
  advice: PostBashAdvice,
): string | null {
  if (!advice.additionalContext) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: advice.additionalContext,
    },
  });
}

export { LARGE_OUTPUT_THRESHOLD_CHARS };
