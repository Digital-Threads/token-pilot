/**
 * Phase 4 subtask 4.3 — agent composer.
 *
 * Composes a final agent markdown by splicing three source parts:
 *   1. `templates/agents/tp-NAME.md` — frontmatter + role block (source of truth)
 *   2. `templates/agents/_shared-preamble.md` — MCP-first contract
 *   3. `templates/agents/_response-contract.md` — output discipline
 *
 * Deliberately uses a regex split instead of parseFrontmatter/writeFrontmatter
 * so the frontmatter block is preserved **byte-for-byte** — no YAML re-
 * serialisation that could reorder keys or change quoting.
 *
 * This is a pure in-memory transformation. No files are written by this
 * module; Phase 5 install-agents is the only writer.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/;

/**
 * Pure string-to-string composer.
 *
 * @param source   Content of `tp-NAME.md` (frontmatter + role block).
 * @param shared   Content of `_shared-preamble.md`.
 * @param contract Content of `_response-contract.md`.
 * @returns Composed agent body with exactly one frontmatter block, the
 *   shared preamble immediately after it, the role block next, and the
 *   response contract last. Ends with a single trailing newline.
 * @throws if the source has no recognisable frontmatter delimiter pair.
 */
export function composeAgent(
  source: string,
  shared: string,
  contract: string,
): string {
  const m = source.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error(
      "composeAgent: source has no frontmatter block (expected ---\\n...\\n---\\n at start)",
    );
  }
  const [, frontmatter, roleBlock] = m;

  return (
    frontmatter +
    "\n" +
    shared.trim() +
    "\n\n" +
    roleBlock.trim() +
    "\n\n" +
    contract.trim() +
    "\n"
  );
}

/**
 * File-system wrapper around composeAgent. Reads the three parts from
 * disk and returns the composed string. Does not write anything.
 */
export function composeFromFiles(
  sourcePath: string,
  sharedPath: string,
  contractPath: string,
): string {
  const source = readFileSync(sourcePath, "utf-8");
  const shared = readFileSync(sharedPath, "utf-8");
  const contract = readFileSync(contractPath, "utf-8");
  return composeAgent(source, shared, contract);
}

export interface ComposedAgent {
  /** Agent name (file basename without `.md`). */
  name: string;
  /** Composed markdown ready to be written to `.claude/agents/<name>.md`. */
  composed: string;
}

/**
 * Scans `templatesDir` for `tp-*.md` files and composes each of them,
 * using `_shared-preamble.md` and `_response-contract.md` from the same
 * directory. Files starting with `_` are excluded.
 *
 * Returns an empty array if `templatesDir` contains no `tp-*.md` files
 * (including when the directory is missing, to keep CLI invocations
 * safe on fresh checkouts).
 */
export function composeAll(templatesDir: string): ComposedAgent[] {
  let entries: string[];
  try {
    entries = readdirSync(templatesDir);
  } catch {
    return [];
  }

  const sharedPath = join(templatesDir, "_shared-preamble.md");
  const contractPath = join(templatesDir, "_response-contract.md");

  let shared: string;
  let contract: string;
  try {
    shared = readFileSync(sharedPath, "utf-8");
    contract = readFileSync(contractPath, "utf-8");
  } catch {
    // Missing parts → caller gets nothing; Phase 5 can surface a friendly
    // error. We never throw out of the bulk path.
    return [];
  }

  const results: ComposedAgent[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry.startsWith("_")) continue;
    if (!entry.startsWith("tp-")) continue;

    const name = entry.replace(/\.md$/, "");
    try {
      const source = readFileSync(join(templatesDir, entry), "utf-8");
      results.push({ name, composed: composeAgent(source, shared, contract) });
    } catch {
      // Skip unreadable / malformed source; Phase 5 may log.
    }
  }
  return results;
}
