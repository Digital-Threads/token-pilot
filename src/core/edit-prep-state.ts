/**
 * Shared disk state so a PreToolUse:Edit hook subprocess can tell whether
 * the main-thread agent actually called `read_for_edit` before the Edit.
 *
 * Why file-backed: hook subprocesses spawn fresh per-call and see no
 * in-process state from the MCP server. Keyed by a hash of projectRoot so
 * two concurrent projects on the same machine don't cross-contaminate.
 * Entries expire after 30 minutes — long enough to cover a typical edit
 * session, short enough that a stale prep from a previous conversation
 * doesn't let a bad Edit slip through tomorrow.
 *
 * All operations are best-effort: any I/O error is swallowed silently.
 * A broken state file must NEVER block an Edit — it's a soft guardrail,
 * not a file-system invariant. If the prep file is unreadable we act as
 * if "no prep exists" and the hook behaves per its enforcement mode.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STATE_DIR_NAME = "token-pilot-edit-prep";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface PrepState {
  /** absolute file path → timestamp-ms when read_for_edit last prepared it */
  paths: Record<string, number>;
}

function stateDir(): string {
  return join(tmpdir(), STATE_DIR_NAME);
}

function stateFile(projectRoot: string): string {
  const hash = createHash("sha1")
    .update(resolve(projectRoot))
    .digest("hex")
    .slice(0, 16);
  return join(stateDir(), `${hash}.json`);
}

function loadState(projectRoot: string): PrepState {
  try {
    const txt = readFileSync(stateFile(projectRoot), "utf-8");
    const parsed = JSON.parse(txt) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "paths" in parsed &&
      typeof (parsed as PrepState).paths === "object"
    ) {
      return parsed as PrepState;
    }
  } catch {
    /* corrupt / missing — fall through */
  }
  return { paths: {} };
}

function pruneExpired(state: PrepState, ttlMs: number, now: number): PrepState {
  const fresh: Record<string, number> = {};
  for (const [p, ts] of Object.entries(state.paths)) {
    if (typeof ts === "number" && now - ts < ttlMs) {
      fresh[p] = ts;
    }
  }
  return { paths: fresh };
}

/**
 * Record that `read_for_edit` was just called for `absPath`.
 * Safe to call in any order, from any process — atomically rewrites the
 * state file so a racing read never sees a half-written JSON.
 */
export function markEditPrepared(
  projectRoot: string,
  absPath: string,
  now: number = Date.now(),
): void {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const state = pruneExpired(loadState(projectRoot), DEFAULT_TTL_MS, now);
    state.paths[resolve(absPath)] = now;

    const file = stateFile(projectRoot);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch {
    /* best-effort — see module doc */
  }
}

/**
 * Has `read_for_edit` been called for `absPath` recently enough to
 * authorise a follow-up Edit? Auto-prunes entries older than TTL.
 */
export function isEditPrepared(
  projectRoot: string,
  absPath: string,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_TTL_MS,
): boolean {
  const state = pruneExpired(loadState(projectRoot), ttlMs, now);
  return typeof state.paths[resolve(absPath)] === "number";
}

/**
 * Clear all prep state for a project root. Intended for tests and for the
 * `doctor` CLI if we ever want an explicit reset button.
 */
export function clearEditPrep(projectRoot: string): void {
  try {
    const file = stateFile(projectRoot);
    if (existsSync(file)) {
      writeFileSync(file, JSON.stringify({ paths: {} }));
    }
  } catch {
    /* best effort */
  }
}

/** Exposed for tests so they don't need to import tmpdir themselves. */
export const __test__ = {
  stateDir,
  stateFile,
  DEFAULT_TTL_MS,
};
