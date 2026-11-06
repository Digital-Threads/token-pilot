/**
 * Reverse side of `bless-agents` (Phase 3 subtask 3.6).
 *
 * Walks `./.claude/agents/*.md` in the project, parses each file's
 * frontmatter, and deletes only files that carry the explicit
 * `token_pilot.blessed: true` marker. Files without that marker — user's
 * own customised agents, other plugins' overrides — are left untouched.
 *
 * The function never throws out: every I/O failure is captured in the
 * returned summary so the caller can surface one human-readable stderr
 * message afterwards.
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./agent-frontmatter.js";

export interface UnblessOptions {
  /** Project root — .claude/agents is resolved relative to this. */
  projectRoot: string;
  /** Specific agent names (without ".md"). Ignored when `all` is true. */
  names: string[];
  /** When true, remove every blessed file regardless of `names`. */
  all: boolean;
}

export interface UnblessSummary {
  /** Count of files deleted. */
  removed: number;
  /** Count of files intentionally skipped (missing, not blessed, etc.). */
  skipped: number;
  /** Details for skipped entries; useful for stderr reporting. */
  skipDetails: Array<{ name: string; reason: string }>;
}

function isBlessedMarker(meta: Record<string, unknown>): boolean {
  const tp = meta.token_pilot;
  if (typeof tp !== "object" || tp === null) return false;
  return (tp as { blessed?: unknown }).blessed === true;
}

export async function unblessAgents(
  opts: UnblessOptions,
): Promise<UnblessSummary> {
  const summary: UnblessSummary = { removed: 0, skipped: 0, skipDetails: [] };
  const agentsDir = join(opts.projectRoot, ".claude", "agents");

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    // No .claude/agents dir → nothing to do; treat as success.
    return summary;
  }

  const files = entries.filter((f) => f.endsWith(".md"));
  const filesByName = new Map(files.map((f) => [f.replace(/\.md$/, ""), f]));

  const targetNames = opts.all
    ? files.map((f) => f.replace(/\.md$/, ""))
    : opts.names;

  for (const name of targetNames) {
    const fileName = filesByName.get(name);
    if (!fileName) {
      summary.skipped++;
      summary.skipDetails.push({ name, reason: "not found" });
      continue;
    }
    const fullPath = join(agentsDir, fileName);

    let body: string;
    try {
      body = await readFile(fullPath, "utf-8");
    } catch {
      summary.skipped++;
      summary.skipDetails.push({ name, reason: "read error" });
      continue;
    }

    let meta: Record<string, unknown>;
    try {
      ({ meta } = parseFrontmatter(body));
    } catch {
      summary.skipped++;
      summary.skipDetails.push({ name, reason: "malformed frontmatter" });
      continue;
    }

    if (!isBlessedMarker(meta)) {
      summary.skipped++;
      summary.skipDetails.push({ name, reason: "no blessed marker" });
      continue;
    }

    try {
      await unlink(fullPath);
      summary.removed++;
    } catch {
      summary.skipped++;
      summary.skipDetails.push({ name, reason: "delete failed" });
    }
  }

  // Emit one human-readable stderr line when we actually removed something.
  if (summary.removed > 0) {
    const plural = summary.removed === 1 ? "agent" : "agents";
    process.stderr.write(
      `[token-pilot] Unblessed ${summary.removed} ${plural}.\n`,
    );
  }

  return summary;
}
