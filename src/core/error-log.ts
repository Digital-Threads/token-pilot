/**
 * v0.34.0 — error / diagnostic channel for token-pilot hooks + CLI.
 *
 * Why a separate file from `hook-events.jsonl`:
 *   - hook-events lives in `<projectRoot>/.token-pilot/`. When the hook
 *     itself fails BEFORE projectRoot is resolved (B8 WSL detection,
 *     missing dir, ENOENT), there is nowhere to write the regular log.
 *   - Errors must outlive a single project — when a user reports
 *     "nothing logs anymore" we want one absolute path to look at.
 *
 * Layout:
 *   ~/.token-pilot/hook-errors.jsonl
 *
 * Format: one JSON record per line. Schema in `HookErrorRecord` below.
 *
 * Discipline:
 *   - Never throws. The error logger is itself the last line of defence —
 *     a throw here would defeat the wrapper that calls it.
 *   - Cap-and-rotate: when the file passes MAX_BYTES the writer renames
 *     it to `hook-errors.<ts>.jsonl` and starts fresh. Old archives
 *     past RETENTION_MS are pruned best-effort on each append.
 *   - `TOKEN_PILOT_NO_ERROR_LOG=1` opts out entirely.
 *
 * Privacy:
 *   - The `input` field is whatever the hook chose to record. Callers
 *     MUST sanitize before passing it in — no full paths, no file
 *     content, no prompts. Helpers `safeBasename()` / `safePathInfo()`
 *     are provided for the common cases.
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ─── types ───────────────────────────────────────────────────────────

export type ErrorLevel = "info" | "warn" | "error";

export interface HookErrorRecord {
  ts: number;
  hook: string;
  level: ErrorLevel;
  code: string;
  msg: string;
  stack?: string;
  input?: Record<string, unknown>;
  pluginVersion?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}

// ─── constants ───────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB before rotate
const RETENTION_MS = 30 * 24 * 3600 * 1000; // 30d archive retention
const ARCHIVE_RE = /^hook-errors\.(\d+)\.jsonl$/;
const CURRENT = "hook-errors.jsonl";

// ─── path resolution ─────────────────────────────────────────────────

export function errorLogDir(): string {
  return join(homedir(), ".token-pilot");
}
export function errorLogPath(): string {
  return join(errorLogDir(), CURRENT);
}

// ─── env opt-out ─────────────────────────────────────────────────────

function isOptedOut(): boolean {
  return process.env.TOKEN_PILOT_NO_ERROR_LOG === "1";
}

// ─── sanitizers ──────────────────────────────────────────────────────

/**
 * Reduce a path to its basename. Use everywhere a path could leak:
 * the user's project tree, file content, anything not strictly an
 * identifier. Returns `"<empty>"` for missing input rather than null
 * so the field stays shape-stable.
 */
export function safeBasename(p: unknown): string {
  if (typeof p !== "string" || p.length === 0) return "<empty>";
  return basename(p);
}

/**
 * Capture only the metadata about a path — basename + length + ext —
 * dropping the absolute path entirely. Useful when the analysis
 * benefits from "kind of file" without revealing where it lived.
 */
export function safePathInfo(p: unknown): {
  name: string;
  ext: string;
} {
  if (typeof p !== "string" || p.length === 0) {
    return { name: "<empty>", ext: "" };
  }
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return {
    name,
    ext: dot >= 0 ? name.slice(dot).toLowerCase() : "",
  };
}

// ─── error classification ────────────────────────────────────────────

/**
 * Map a thrown value to a stable, searchable `code`. The classifier
 * is intentionally simple — node ErrnoException codes pass through,
 * everything else falls into a coarse bucket. New cases land here
 * only when a pattern shows up repeatedly in the wild.
 */
export function classifyError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as NodeJS.ErrnoException;
    if (typeof e.code === "string" && e.code.length > 0) return e.code;
    const name = (e as Error).name;
    if (name === "SyntaxError") return "parse_error";
    if (name === "TypeError") return "type_error";
  }
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes("timeout")) return "timeout";
    if (m.includes("not initialized")) return "not_initialized";
    if (m.includes("permission denied")) return "EACCES";
  }
  return "unknown";
}

// ─── rotate + retention ──────────────────────────────────────────────

async function rotateIfNeeded(): Promise<void> {
  const p = errorLogPath();
  try {
    const stat = await fs.stat(p);
    if (stat.size < MAX_BYTES) return;
    const archive = join(errorLogDir(), `hook-errors.${Date.now()}.jsonl`);
    await fs.rename(p, archive);
  } catch {
    /* missing or stat failure — append will create */
  }
}

async function pruneArchives(): Promise<void> {
  const dir = errorLogDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_MS;
  for (const name of entries) {
    const m = name.match(ARCHIVE_RE);
    if (!m) continue;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoff) {
      try {
        await fs.unlink(join(dir, name));
      } catch {
        /* best-effort */
      }
    }
  }
}

// ─── append ──────────────────────────────────────────────────────────

export async function appendError(rec: HookErrorRecord): Promise<void> {
  if (isOptedOut()) return;
  try {
    await fs.mkdir(errorLogDir(), { recursive: true });
    await rotateIfNeeded();
    await fs.appendFile(errorLogPath(), JSON.stringify(rec) + "\n");
    // best-effort retention sweep — not awaited tightly because a slow
    // FS shouldn't slow the hook hot-path; failures are silent.
    pruneArchives().catch(() => {});
  } catch {
    /* logger of last resort — never throw */
  }
}

// ─── load ────────────────────────────────────────────────────────────

export interface LoadErrorsOptions {
  /** Limit to the last N records (most recent first). */
  tail?: number;
  /** Filter by `code`. */
  code?: string;
  /** Filter by `hook` name. */
  hook?: string;
  /** Filter by `level`. */
  level?: ErrorLevel;
  /** Override the default current-log path (testing). */
  path?: string;
}

export async function loadErrors(
  opts: LoadErrorsOptions = {},
): Promise<HookErrorRecord[]> {
  const p = opts.path ?? errorLogPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch {
    return [];
  }
  const out: HookErrorRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as HookErrorRecord;
      if (opts.code && rec.code !== opts.code) continue;
      if (opts.hook && rec.hook !== opts.hook) continue;
      if (opts.level && rec.level !== opts.level) continue;
      out.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  // Newest first — most useful default ordering for a tail view.
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (opts.tail && opts.tail > 0) {
    return out.slice(0, opts.tail);
  }
  return out;
}

// ─── format ──────────────────────────────────────────────────────────

export function formatErrorList(records: HookErrorRecord[]): string {
  if (records.length === 0) {
    return "No errors logged.";
  }
  const counts = new Map<string, number>();
  for (const r of records) {
    counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const lines: string[] = [];
  lines.push(`token-pilot errors — ${records.length} total`);
  lines.push("");
  lines.push("Top codes:");
  for (const [code, n] of top) {
    lines.push(`  ${String(n).padStart(4)}× ${code}`);
  }
  lines.push("");
  lines.push("Most recent:");
  const recent = records.slice(0, 20);
  for (const r of recent) {
    const when = new Date(r.ts).toISOString().slice(11, 19);
    lines.push(
      `  [${when}] ${r.level.toUpperCase().padEnd(5)} ${r.hook} ${r.code} — ${r.msg}`,
    );
  }
  return lines.join("\n");
}

// ─── exports for indirection from index.ts ───────────────────────────

export { existsSync, resolve, dirname };
