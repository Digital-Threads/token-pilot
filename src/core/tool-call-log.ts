/**
 * v0.26.2 — persistent MCP tool-call log.
 *
 * Separate from `hook-events.jsonl` (which records Read-hook outcomes),
 * this file accumulates every MCP tool invocation with its token
 * accounting across ALL sessions. Used by `npx token-pilot tool-audit`
 * to produce a per-tool savings distribution that survives `/clear`,
 * session restarts, and even reboots — i.e. the data-driven base we
 * need before pruning or modifying tools based on "savings".
 *
 * Why not piggy-back on hook-events.jsonl? Different data model: hook
 * events are a denied/allowed bitstream keyed by filepath+lineCount,
 * tool calls are rich records with tokensReturned, wouldBe, category,
 * delegation status. Forcing both into one schema would hurt both
 * readers.
 *
 * File path: `<projectRoot>/.token-pilot/tool-calls.jsonl`. Rotation,
 * retention, and best-effort error handling follow the same contract
 * as event-log.ts — identical 10 MB / 30-day / 100 MB caps so overall
 * .token-pilot/ disk usage stays predictable.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SavingsCategory } from "./session-analytics.js";

export const TOOL_LOG_ROTATION_BYTES = 10_000_000;
export const TOOL_LOG_RETENTION_MAX_AGE_DAYS = 30;
export const TOOL_LOG_RETENTION_MAX_TOTAL_BYTES = 100_000_000;

const CURRENT_FILE = "tool-calls.jsonl";
const ARCHIVE_RE = /^tool-calls\.\d+\.jsonl$/;

/**
 * Persisted shape of one MCP tool call. Mirrors the in-memory
 * `ToolCall` in session-analytics.ts but trims runtime-only fields
 * (intent, decisionTrace — those are re-derivable from args/tool if
 * ever needed, not worth the disk cost).
 */
export interface ToolCallEvent {
  ts: number;
  session_id: string;
  tool: string;
  path?: string;
  tokensReturned: number;
  tokensWouldBe: number;
  savingsCategory: SavingsCategory;
  sessionCacheHit?: boolean;
  delegatedToContextMode?: boolean;
}

function toolLogDir(projectRoot: string): string {
  return join(projectRoot, ".token-pilot");
}

export function currentToolLogPath(projectRoot: string): string {
  return join(toolLogDir(projectRoot), CURRENT_FILE);
}

async function ensureDir(projectRoot: string): Promise<void> {
  await fs.mkdir(toolLogDir(projectRoot), { recursive: true });
}

async function rotateIfNeeded(
  projectRoot: string,
  thresholdBytes: number = TOOL_LOG_ROTATION_BYTES,
): Promise<void> {
  const current = currentToolLogPath(projectRoot);
  try {
    const s = await fs.stat(current);
    if (s.size < thresholdBytes) return;
  } catch {
    return; // no file → nothing to rotate
  }
  const archive = join(
    toolLogDir(projectRoot),
    `tool-calls.${Date.now()}.jsonl`,
  );
  try {
    await fs.rename(current, archive);
  } catch {
    /* raced — next writer will append onto whichever file exists */
  }
}

/**
 * Append one tool call. Never throws — telemetry must not break the
 * tool-response path (the caller awaits this but treats errors as
 * silent via `.catch(() => undefined)` at the call site).
 */
export async function appendToolCall(
  projectRoot: string,
  event: ToolCallEvent,
): Promise<void> {
  try {
    await ensureDir(projectRoot);
    await rotateIfNeeded(projectRoot);
    await fs.appendFile(
      currentToolLogPath(projectRoot),
      JSON.stringify(event) + "\n",
    );
  } catch {
    /* silent */
  }
}

/**
 * Read every tool-call event from the current file + all archives.
 * Malformed JSONL lines are skipped silently — one bad line should not
 * poison the dataset. Returns events in *insertion order within each
 * file*, which happens to be chronological because append-only.
 */
export async function loadAllToolCalls(
  projectRoot: string,
): Promise<ToolCallEvent[]> {
  const dir = toolLogDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  if (entries.includes(CURRENT_FILE)) files.push(CURRENT_FILE);
  for (const n of entries) if (ARCHIVE_RE.test(n)) files.push(n);

  const out: ToolCallEvent[] = [];
  for (const name of files) {
    let raw: string;
    try {
      raw = await fs.readFile(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ToolCallEvent);
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

// ─── retention (mirrors event-log) ──────────────────────────────────────────

export function retentionDeletions(
  files: Array<{ path: string; mtime: Date; size: number }>,
  now: Date,
  maxAgeDays: number = TOOL_LOG_RETENTION_MAX_AGE_DAYS,
  maxTotalBytes: number = TOOL_LOG_RETENTION_MAX_TOTAL_BYTES,
): string[] {
  const toDelete = new Set<string>();
  const maxAgeMs = maxAgeDays * 86_400_000;

  const survivors: Array<{ path: string; mtime: Date; size: number }> = [];
  for (const f of files) {
    if (now.getTime() - f.mtime.getTime() > maxAgeMs) {
      toDelete.add(f.path);
    } else {
      survivors.push(f);
    }
  }

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

export async function applyRetention(
  projectRoot: string,
  now: Date = new Date(),
): Promise<void> {
  const dir = toolLogDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const archives: Array<{ path: string; mtime: Date; size: number }> = [];
  for (const name of entries) {
    if (!ARCHIVE_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const s = await fs.stat(full);
      archives.push({ path: full, mtime: s.mtime, size: s.size });
    } catch {
      /* unreadable → skip */
    }
  }
  for (const p of retentionDeletions(archives, now)) {
    try {
      await fs.unlink(p);
    } catch {
      /* ignore */
    }
  }
}
