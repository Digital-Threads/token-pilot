/**
 * TP-340 — auto-snapshot + auto-restore.
 *
 * When an agent calls session_snapshot(), we persist the rendered block
 * to `.token-pilot/snapshots/<iso>.md` AND keep a `latest.md` pointing at
 * the newest snapshot. SessionStart hook can then surface a short reminder
 * so the next Claude Code turn picks the thread back up after compaction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistSnapshot,
  loadLatestSnapshot,
  SNAPSHOT_SUBDIR,
  LATEST_FILE,
} from "../../src/handlers/session-snapshot-persist.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-snapshot-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("persistSnapshot", () => {
  it("writes the snapshot body to a timestamped file + latest.md", async () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const res = await persistSnapshot({
      projectRoot: tempDir,
      body: "## Session State\n**Goal:** ship TP-340\n",
      now,
    });
    expect(res.archivedPath).toMatch(/snapshots\/2026-04-18T12-00-00/);
    expect(res.latestPath).toBe(join(tempDir, SNAPSHOT_SUBDIR, LATEST_FILE));
    expect(await readFile(res.latestPath, "utf-8")).toContain("TP-340");
    expect(await readFile(res.archivedPath!, "utf-8")).toContain("TP-340");
  });

  it("each call rewrites latest.md but keeps history", async () => {
    await persistSnapshot({
      projectRoot: tempDir,
      body: "first",
      now: new Date("2026-04-18T10:00:00Z"),
    });
    await persistSnapshot({
      projectRoot: tempDir,
      body: "second",
      now: new Date("2026-04-18T11:00:00Z"),
    });
    const latest = await readFile(
      join(tempDir, SNAPSHOT_SUBDIR, LATEST_FILE),
      "utf-8",
    );
    expect(latest).toBe("second");
    const archive = await readdir(join(tempDir, SNAPSHOT_SUBDIR));
    const mdFiles = archive.filter(
      (n) => n.endsWith(".md") && n !== LATEST_FILE,
    );
    expect(mdFiles.length).toBe(2);
  });

  it("keeps only the last 10 archived snapshots", async () => {
    for (let i = 0; i < 15; i++) {
      await persistSnapshot({
        projectRoot: tempDir,
        body: `snap-${i}`,
        now: new Date(Date.UTC(2026, 3, 18, 0, i, 0)),
      });
    }
    const archive = await readdir(join(tempDir, SNAPSHOT_SUBDIR));
    const mdFiles = archive
      .filter((n) => n.endsWith(".md") && n !== LATEST_FILE)
      .sort();
    expect(mdFiles.length).toBe(10);
    // Oldest 5 should be trimmed
    expect(mdFiles[0]).not.toMatch(/00-0[01234]-00/);
  });
});

describe("loadLatestSnapshot", () => {
  it("returns null when no snapshots exist", async () => {
    const res = await loadLatestSnapshot(tempDir);
    expect(res).toBeNull();
  });

  it("returns the body + age when latest.md exists", async () => {
    await persistSnapshot({
      projectRoot: tempDir,
      body: "## Session State\n**Goal:** test\n",
    });
    const res = await loadLatestSnapshot(tempDir);
    expect(res).not.toBeNull();
    expect(res!.body).toContain("Goal:");
    // ageMs is derived from real mtime, so we only assert non-negative.
    expect(res!.ageMs).toBeGreaterThanOrEqual(0);
    const latestStat = await stat(join(tempDir, SNAPSHOT_SUBDIR, LATEST_FILE));
    expect(res!.mtimeMs).toBe(latestStat.mtimeMs);
  });
});
