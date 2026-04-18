/**
 * Sum `savedTokens` for all hook-events matching a given session_id.
 *
 * Used by the adaptive-threshold path to estimate how much of the
 * session's context budget has already been burned. Sync implementation
 * because the hook process is short-lived and a blocking read is
 * simpler than pulling in async plumbing.
 *
 * Silent on every error — telemetry must never break the hook.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadSessionSavedTokens(
  projectRoot: string,
  sessionId: string,
): number {
  if (!sessionId) return 0;
  const path = join(projectRoot, ".token-pilot", "hook-events.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        session_id?: string;
        savedTokens?: number;
      };
      if (e.session_id === sessionId && typeof e.savedTokens === "number") {
        total += e.savedTokens;
      }
    } catch {
      /* skip malformed */
    }
  }
  return total;
}
