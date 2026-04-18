/**
 * TP-rtg (part 2) — CLAUDE.md hygiene assessment.
 *
 * Claude Code injects the project's `CLAUDE.md` into every message. A
 * 200-line rules file therefore costs thousands of tokens per turn.
 * Community guide B3 recommends keeping it under 60 non-empty lines and
 * loading deeper instructions on demand from `docs/`.
 *
 * This module only *measures*. It does not touch the file. The caller
 * (doctor / init) decides how to surface the tip.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CLAUDE_MD_LINE_THRESHOLD = 60;

export type ClaudeMdAssessment =
  | { kind: "missing" }
  | { kind: "ok"; path: string; nonEmptyLines: number }
  | {
      kind: "bloated";
      path: string;
      nonEmptyLines: number;
      threshold: number;
    };

function countNonEmptyLines(content: string): number {
  let n = 0;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    // Treat markdown horizontal rules as separators, not content.
    if (/^-{3,}$|^_{3,}$|^\*{3,}$/.test(line)) continue;
    n += 1;
  }
  return n;
}

export async function assessClaudeMd(
  projectRoot: string,
  threshold: number = CLAUDE_MD_LINE_THRESHOLD,
): Promise<ClaudeMdAssessment> {
  const path = join(projectRoot, "CLAUDE.md");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { kind: "missing" };
  }
  const nonEmptyLines = countNonEmptyLines(content);
  if (nonEmptyLines > threshold) {
    return { kind: "bloated", path, nonEmptyLines, threshold };
  }
  return { kind: "ok", path, nonEmptyLines };
}
