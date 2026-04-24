/**
 * Ecosystem reminder — a one-shot nudge at MCP-server startup suggesting
 * the user install caveman for output-side compression.
 *
 * Design lifted from `maybeEmitStartupReminder` (tp-* agents):
 *   - at most once per process (new Claude Code session = new process =
 *     new single reminder, not a per-session banner every turn);
 *   - silent when the user already installed caveman;
 *   - silenced completely by `TOKEN_PILOT_NO_ECOSYSTEM_TIPS=1`;
 *   - silenced inside spawned subagents (`TOKEN_PILOT_SUBAGENT=1`) so
 *     the banner never surfaces through Task-dispatched helpers.
 *
 * Three stderr lines is the max we allow — the whole point is to be
 * helpful without being the thing that bloats the user's first impression.
 */

import { checkEcosystem } from "./ecosystem-check.js";

let emitted = false;

export interface EcosystemReminderOptions {
  env?: NodeJS.ProcessEnv;
}

const MESSAGE =
  "[token-pilot] Tip: pair with caveman for ~75% output token savings\n" +
  "  install: claude plugin install caveman@caveman\n" +
  "  silence: set TOKEN_PILOT_NO_ECOSYSTEM_TIPS=1\n";

/**
 * Pure predicate — is a reminder currently warranted?
 * Exposed separately from the stateful emitter so tests can exercise the
 * decision matrix without touching stderr or the single-fire latch.
 */
export function shouldEmitEcosystemReminder(
  opts: EcosystemReminderOptions = {},
): boolean {
  const env = opts.env ?? process.env;
  if (env.TOKEN_PILOT_NO_ECOSYSTEM_TIPS === "1") return false;
  if (env.TOKEN_PILOT_SUBAGENT === "1") return false;

  const statuses = checkEcosystem();
  const caveman = statuses.find((s) => s.id === "caveman");
  // Only remind when we're actually sure caveman is missing. If detection
  // is "unknown" (future value, permission-denied HOME, etc.) we stay
  // silent — a wrong nudge is worse than no nudge.
  return caveman?.status === "not-installed";
}

/**
 * Emit the reminder to stderr if conditions warrant it. Single-fire per
 * process. Returns `true` iff it actually wrote output, so callers can
 * log telemetry without racing the latch.
 */
export function maybeEmitEcosystemReminder(
  opts: EcosystemReminderOptions = {},
): boolean {
  if (emitted) return false;
  if (!shouldEmitEcosystemReminder(opts)) return false;
  process.stderr.write(MESSAGE);
  emitted = true;
  return true;
}

/** Test-only: reset the single-fire guard between test cases. */
export function __resetEcosystemReminder(): void {
  emitted = false;
}

/** Test-only: expose the canonical message for assertion. */
export const __ECOSYSTEM_REMINDER_MESSAGE = MESSAGE;
