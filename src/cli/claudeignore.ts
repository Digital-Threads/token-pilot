/**
 * TP-rtg (part 1) — `.claudeignore` generator.
 *
 * The `.claudeignore` file is a community convention (mirrors `.gitignore`):
 * Claude Code and other tools skip listed paths when building context.
 * Populating it with sensible defaults gives a one-time, permanent drop in
 * per-message token cost (node_modules, dist, lockfiles etc.).
 *
 * Non-destructive: we never overwrite a user-owned file. The file we
 * generate carries a magic comment so the tool can recognise its own
 * past output on re-run and refresh the defaults in place.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

export const CLAUDEIGNORE_MANAGED_MARKER =
  "# token-pilot managed defaults (safe to edit; marker keeps this file auto-refreshable)";

export const DEFAULT_IGNORE_ENTRIES: readonly string[] = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  "coverage/",
  ".coverage/",
  "*.min.js",
  "*.min.css",
  "*.map",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
  "composer.lock",
];

export type ClaudeIgnoreStatus =
  | { kind: "absent" }
  | { kind: "managed" }
  | { kind: "user-owned" };

function pathFor(projectRoot: string): string {
  return join(projectRoot, ".claudeignore");
}

/**
 * Determine the current state of `<projectRoot>/.claudeignore`:
 * absent, written by us (managed), or authored by the user (user-owned).
 */
export async function claudeIgnoreStatus(
  projectRoot: string,
): Promise<ClaudeIgnoreStatus> {
  const p = pathFor(projectRoot);
  try {
    await access(p);
  } catch {
    return { kind: "absent" };
  }
  try {
    const content = await readFile(p, "utf-8");
    if (content.includes(CLAUDEIGNORE_MANAGED_MARKER))
      return { kind: "managed" };
    return { kind: "user-owned" };
  } catch {
    return { kind: "user-owned" };
  }
}

/**
 * Write (or refresh) the default `.claudeignore`. Returns true when we
 * actually touched the file, false when we refused to avoid clobbering
 * user content.
 */
export async function writeDefaultClaudeIgnore(
  projectRoot: string,
): Promise<boolean> {
  const status = await claudeIgnoreStatus(projectRoot);
  if (status.kind === "user-owned") return false;

  const body =
    `${CLAUDEIGNORE_MANAGED_MARKER}\n` +
    `# Paths Claude Code and friendly tools will skip when building context.\n` +
    `# Remove or edit entries; the marker line above keeps this file refreshable\n` +
    `# by \`token-pilot init\` / \`token-pilot doctor\`.\n\n` +
    DEFAULT_IGNORE_ENTRIES.join("\n") +
    "\n";
  try {
    await writeFile(pathFor(projectRoot), body);
    return true;
  } catch {
    return false;
  }
}
