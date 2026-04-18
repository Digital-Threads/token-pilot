/**
 * TP-340 — persistence layer for session_snapshot.
 *
 * When an agent calls `session_snapshot` we save the rendered block to
 *   `.token-pilot/snapshots/<iso>.md`          (archived history)
 *   `.token-pilot/snapshots/latest.md`         (always the newest)
 *
 * A SessionStart hook later reads `latest.md` and surfaces a short pointer
 * so the next Claude Code turn after compaction / `/clear` / a new window
 * can pick the thread back up without re-hydrating context manually.
 *
 * Retention: keep the last `MAX_ARCHIVED_SNAPSHOTS` (oldest trimmed first).
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_SUBDIR = ".token-pilot/snapshots";
export const LATEST_FILE = "latest.md";
export const MAX_ARCHIVED_SNAPSHOTS = 10;

export interface PersistSnapshotInput {
  projectRoot: string;
  body: string;
  /** For deterministic tests; defaults to `new Date()`. */
  now?: Date;
}

export interface PersistSnapshotResult {
  archivedPath: string | null;
  latestPath: string;
}

function formatIsoStamp(d: Date): string {
  // Safe-for-filename ISO: 2026-04-18T12-00-00Z
  return d.toISOString().replace(/:/g, "-").replace(/\..+/, "Z");
}

export async function persistSnapshot(
  input: PersistSnapshotInput,
): Promise<PersistSnapshotResult> {
  const now = input.now ?? new Date();
  const dir = join(input.projectRoot, SNAPSHOT_SUBDIR);
  await fs.mkdir(dir, { recursive: true });

  const stamp = formatIsoStamp(now);
  const archivedPath = join(dir, `${stamp}.md`);
  const latestPath = join(dir, LATEST_FILE);

  await fs.writeFile(archivedPath, input.body);
  await fs.writeFile(latestPath, input.body);

  await trimArchive(dir);

  return { archivedPath, latestPath };
}

async function trimArchive(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const archived = entries
    .filter((n) => n.endsWith(".md") && n !== LATEST_FILE)
    .sort(); // ISO-stamped names sort chronologically
  if (archived.length <= MAX_ARCHIVED_SNAPSHOTS) return;
  const excess = archived.length - MAX_ARCHIVED_SNAPSHOTS;
  for (let i = 0; i < excess; i++) {
    try {
      await fs.unlink(join(dir, archived[i]));
    } catch {
      /* best effort */
    }
  }
}

export interface LoadedSnapshot {
  body: string;
  mtimeMs: number;
  ageMs: number;
  path: string;
}

export async function loadLatestSnapshot(
  projectRoot: string,
): Promise<LoadedSnapshot | null> {
  const path = join(projectRoot, SNAPSHOT_SUBDIR, LATEST_FILE);
  try {
    const [body, s] = await Promise.all([
      fs.readFile(path, "utf-8"),
      fs.stat(path),
    ]);
    return {
      body,
      mtimeMs: s.mtimeMs,
      ageMs: Math.max(0, Date.now() - s.mtimeMs),
      path,
    };
  } catch {
    return null;
  }
}
