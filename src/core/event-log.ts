/**
 * Phase 6 subtasks 6.1 + 6.2 — hook-events JSONL log.
 *
 * Writes to `<projectRoot>/.token-pilot/hook-events.jsonl` with the
 * schema specified in TP-c2a acceptance:
 *
 *   { ts, session_id, agent_type, agent_id, event, file, lines,
 *     estTokens, summaryTokens, savedTokens }
 *
 * Rotation: when the current file grows past `ROTATION_THRESHOLD_BYTES`
 * (10 MB), it is renamed to `hook-events.<unix-ms>.jsonl` and a new
 * empty file begins.
 *
 * Retention: `applyRetention` deletes rotated files older than
 * `RETENTION_MAX_AGE_DAYS` (30 days) and trims the directory down to
 * `RETENTION_MAX_TOTAL_BYTES` (100 MB) by removing the oldest archives
 * first. The current file is never deleted.
 *
 * Legacy coexistence: the old `.token-pilot/hook-denied.jsonl` is left
 * in place — this module writes only to the new file.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

export const ROTATION_THRESHOLD_BYTES = 10_000_000;
export const RETENTION_MAX_AGE_DAYS = 30;
export const RETENTION_MAX_TOTAL_BYTES = 100_000_000;

const CURRENT_FILE = "hook-events.jsonl";
const ARCHIVE_RE = /^hook-events\.\d+\.jsonl$/;

export interface HookEvent {
  ts: number;
  session_id: string;
  /** null for top-level session; agent_type string inside a subagent. */
  agent_type: string | null;
  agent_id: string | null;
  event: "denied" | "allowed" | "bypass" | "pass-through" | string;
  file: string;
  lines: number;
  estTokens: number;
  /** Tokens delivered back to the agent as the summary; 0 for allow/bypass. */
  summaryTokens: number;
  /** estTokens - summaryTokens; 0 for allow/bypass. */
  savedTokens: number;
}

export function eventLogDir(projectRoot: string): string {
  return join(projectRoot, ".token-pilot");
}

export function currentLogPath(projectRoot: string): string {
  return join(eventLogDir(projectRoot), CURRENT_FILE);
}

// ─── pure: rotation predicate ───────────────────────────────────────────────

/**
 * Decide whether the current log file has grown past the rotation
 * threshold and should be archived before the next append.
 */
export function shouldRotate(
  stat: { size: number },
  thresholdBytes: number = ROTATION_THRESHOLD_BYTES,
): boolean {
  return stat.size >= thresholdBytes;
}

// ─── pure: retention policy ─────────────────────────────────────────────────

/**
 * Given the full list of archive files with their mtime + size, return
 * the subset whose paths should be deleted to satisfy:
 *   (a) maxAgeDays — delete anything older
 *   (b) maxTotalBytes — delete oldest first until total fits
 *
 * `now` is passed in to keep the function deterministic for tests.
 */
export function retentionDeletions(
  files: Array<{ path: string; mtime: Date; size: number }>,
  now: Date,
  maxAgeDays: number = RETENTION_MAX_AGE_DAYS,
  maxTotalBytes: number = RETENTION_MAX_TOTAL_BYTES,
): string[] {
  const toDelete = new Set<string>();
  const maxAgeMs = maxAgeDays * 86_400_000;

  // (a) age-based
  const survivors: Array<{ path: string; mtime: Date; size: number }> = [];
  for (const f of files) {
    if (now.getTime() - f.mtime.getTime() > maxAgeMs) {
      toDelete.add(f.path);
    } else {
      survivors.push(f);
    }
  }

  // (b) size-based — delete oldest first from survivors until cap is met
  const totalSize = survivors.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > maxTotalBytes) {
    const byOldest = [...survivors].sort(
      (a, b) => a.mtime.getTime() - b.mtime.getTime(),
    );
    let trimmed = totalSize;
    for (const f of byOldest) {
      if (trimmed <= maxTotalBytes) break;
      toDelete.add(f.path);
      trimmed -= f.size;
    }
  }

  return [...toDelete];
}

// ─── FS wrappers ────────────────────────────────────────────────────────────

async function ensureLogDir(projectRoot: string): Promise<void> {
  await fs.mkdir(eventLogDir(projectRoot), { recursive: true });
}

async function rotateIfNeeded(
  projectRoot: string,
  thresholdBytes: number = ROTATION_THRESHOLD_BYTES,
): Promise<void> {
  const current = currentLogPath(projectRoot);
  let stat: { size: number };
  try {
    const s = await fs.stat(current);
    stat = { size: s.size };
  } catch {
    return; // no current file → nothing to rotate
  }
  if (!shouldRotate(stat, thresholdBytes)) return;
  const archivePath = join(
    eventLogDir(projectRoot),
    `hook-events.${Date.now()}.jsonl`,
  );
  try {
    await fs.rename(current, archivePath);
  } catch {
    // Rename raced with another process; caller will just append onto
    // whichever file now exists.
  }
}

/**
 * Append one event to the current log file. Rotates first if the
 * current file has reached the threshold. Never throws — a failure
 * here must not break hook dispatch.
 */
export async function appendEvent(
  projectRoot: string,
  event: HookEvent,
): Promise<void> {
  try {
    await ensureLogDir(projectRoot);
    await rotateIfNeeded(projectRoot);
    const line = JSON.stringify(event) + "\n";
    await fs.appendFile(currentLogPath(projectRoot), line);
  } catch {
    /* silent — telemetry is best-effort */
  }
}

/**
 * Read all events from the current log file. Malformed JSONL lines are
 * skipped silently (a corrupted line should not poison the whole
 * dataset). Returns [] if the file is missing.
 */
export async function loadEvents(projectRoot: string): Promise<HookEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(currentLogPath(projectRoot), "utf-8");
  } catch {
    return [];
  }
  const out: HookEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HookEvent);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Enumerate all archive files (`hook-events.<ts>.jsonl`) with metadata
 * needed by `retentionDeletions`.
 */
async function listArchives(
  projectRoot: string,
): Promise<Array<{ path: string; mtime: Date; size: number }>> {
  const dir = eventLogDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; mtime: Date; size: number }> = [];
  for (const name of entries) {
    if (!ARCHIVE_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const s = await fs.stat(full);
      out.push({ path: full, mtime: s.mtime, size: s.size });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Apply age + size retention. Safe to call on startup; no-op when the
 * directory does not exist.
 */
export async function applyRetention(
  projectRoot: string,
  now: Date = new Date(),
): Promise<void> {
  const archives = await listArchives(projectRoot);
  const victims = retentionDeletions(archives, now);
  for (const p of victims) {
    try {
      await fs.unlink(p);
    } catch {
      /* ignore */
    }
  }
}
