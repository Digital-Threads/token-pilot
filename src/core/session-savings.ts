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
  return loadSessionStats(projectRoot, sessionId).savedTokens;
}

export interface SessionStats {
  savedTokens: number;
  eventCount: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
}

export function loadSessionStats(
  projectRoot: string,
  sessionId: string,
): SessionStats {
  const empty: SessionStats = {
    savedTokens: 0,
    eventCount: 0,
    firstTsMs: null,
    lastTsMs: null,
  };
  if (!sessionId) return empty;
  const path = join(projectRoot, ".token-pilot", "hook-events.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return empty;
  }
  let savedTokens = 0;
  let eventCount = 0;
  let firstTsMs: number | null = null;
  let lastTsMs: number | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        session_id?: string;
        savedTokens?: number;
        ts?: number;
      };
      if (e.session_id !== sessionId) continue;
      if (typeof e.savedTokens === "number") savedTokens += e.savedTokens;
      eventCount += 1;
      if (typeof e.ts === "number") {
        if (firstTsMs == null || e.ts < firstTsMs) firstTsMs = e.ts;
        if (lastTsMs == null || e.ts > lastTsMs) lastTsMs = e.ts;
      }
    } catch {
      /* skip malformed */
    }
  }
  return { savedTokens, eventCount, firstTsMs, lastTsMs };
}
