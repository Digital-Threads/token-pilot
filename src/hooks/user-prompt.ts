/**
 * UserPromptSubmit reminder hook — per-turn reinforcement of the
 * token-pilot mandatory-tool rules.
 *
 * Why this exists: `hook-session-start` injects the full ruleset exactly
 * once (start / `/clear` / `/compact`). Over a long conversation that
 * block decays out of the model's attention and competing instructions
 * crowd it out, so sessions drift back to raw Read / Grep. The caveman
 * plugin solves the identical problem by re-injecting a tiny anchor on
 * EVERY user message; we do the same — one short line per prompt, the
 * full heavy ruleset stays in SessionStart.
 *
 * Contract: emits `additionalContext` only — never blocks the prompt,
 * never throws. Pure module: the builder takes (enabled, bypass) and
 * returns a string or null; the thin `index.ts` case does the IO.
 */

/**
 * The per-turn anchor. Deliberately one line — re-sending the full
 * mandatory block every turn would burn hundreds of tokens per message
 * inside a tool whose entire point is saving tokens.
 */
export const MINIMAL_ANCHOR =
  "[token-pilot] Before raw Read/Grep/git, use the token-pilot tools: " +
  "smart_read · read_symbol · find_usages · smart_diff / smart_log. " +
  "Delegate scoped work to tp-* specialists. " +
  "Raw Read/Grep only with offset/limit or a narrow regex.";

/**
 * Build the per-turn `additionalContext`, or null when disabled /
 * bypassed (caller emits nothing).
 */
export function buildPromptReminder(
  enabled: boolean,
  bypass: boolean,
): string | null {
  if (!enabled || bypass) return null;
  return MINIMAL_ANCHOR;
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
