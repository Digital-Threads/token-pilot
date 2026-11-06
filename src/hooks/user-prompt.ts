/**
 * UserPromptSubmit hook. Claude Code gets nothing per prompt: each tool's
 * own description says when to use it, and a line repeated on every turn
 * only competes with the user's request. The plugin no longer registers the
 * hook there; an older settings.json entry now runs and stays silent.
 *
 * Codex reads code through the shell, where no tool description is in
 * front of the model, and keeps a one-line anchor.
 *
 * Contract: emits `additionalContext` only — never blocks the prompt,
 * never throws.
 */

/** Codex reads through the shell and has no tp-* agents. */
export const CODEX_ANCHOR =
  "[token-pilot] Before reading code through the shell (cat, sed, grep -r, git), " +
  "use the token-pilot tools: smart_read · read_symbol · find_usages · smart_diff / smart_log.";

/** The per-turn `additionalContext`, or null for nothing. */
export function buildPromptReminder(
  enabled: boolean,
  bypass: boolean,
  client: "claude-code" | "codex" = "claude-code",
): string | null {
  if (!enabled || bypass || client !== "codex") return null;
  return CODEX_ANCHOR;
}

/** Wrap the message in the UserPromptSubmit hook output envelope. */
export function formatPromptReminderOutput(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: message,
    },
  });
}
