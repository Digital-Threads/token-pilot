/**
 * Phase 5 subtask 5.5 — uninstall tp-* agents.
 *
 * Removes only files in the target scope's `.claude/agents/` that have
 * `token_pilot_body_hash` in their frontmatter. Files without the marker
 * are user-owned and are never touched. Scope is required — no global
 * default — to prevent accidental deletion from the wrong location.
 *
 * Symmetric to install-agents: separation of core (uninstallAgents) and
 * CLI wrapper (handleUninstallAgents) mirrors the Phase 3 bless/unbless
 * split.
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./agent-frontmatter.js";

export type Scope = "user" | "project";

export interface UninstallOptions {
  scope: Scope;
  projectRoot: string;
  homeDir: string;
}

export interface UninstallResult {
  removed: string[];
  skipped: Array<{ name: string; reason: string }>;
  targetDir: string;
}

function targetDirFor(opts: UninstallOptions): string {
  const root = opts.scope === "user" ? opts.homeDir : opts.projectRoot;
  return join(root, ".claude", "agents");
}

function hasTpHashMarker(meta: Record<string, unknown>): boolean {
  const h = meta.token_pilot_body_hash;
  return typeof h === "string" && h.length > 0;
}

export async function uninstallAgents(
  opts: UninstallOptions,
): Promise<UninstallResult> {
  const target = targetDirFor(opts);
  const result: UninstallResult = {
    removed: [],
    skipped: [],
    targetDir: target,
  };

  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    // Target dir missing → nothing to do.
    return result;
  }

  const tpFiles = entries.filter(
    (f) => f.endsWith(".md") && f.startsWith("tp-"),
  );

  for (const entry of tpFiles) {
    const name = entry.replace(/\.md$/, "");
    const fullPath = join(target, entry);
    let md: string;
    try {
      md = await readFile(fullPath, "utf-8");
    } catch {
      result.skipped.push({ name, reason: "read failed" });
      continue;
    }

    let meta: Record<string, unknown>;
    try {
      ({ meta } = parseFrontmatter(md));
    } catch {
      result.skipped.push({ name, reason: "malformed frontmatter" });
      continue;
    }

    if (!hasTpHashMarker(meta)) {
      result.skipped.push({
        name,
        reason: "not installed by token-pilot (no token_pilot_body_hash)",
      });
      continue;
    }

    try {
      await unlink(fullPath);
      result.removed.push(name);
    } catch {
      result.skipped.push({ name, reason: "delete failed" });
    }
  }

  return result;
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

function parseFlag(argv: string[], key: string): string | undefined {
  for (const a of argv) {
    if (a === `--${key}`) return "true";
    if (a.startsWith(`--${key}=`)) return a.slice(key.length + 3);
  }
  return undefined;
}

/**
 * CLI entry: `token-pilot uninstall-agents --scope=user|project`.
 * Returns the exit code (0 success, 1 error).
 */
export async function handleUninstallAgents(
  argv: string[],
  opts?: { homeDir?: string; projectRoot?: string },
): Promise<number> {
  const scopeArg = parseFlag(argv, "scope");
  if (scopeArg !== "user" && scopeArg !== "project") {
    process.stderr.write(
      "Usage: token-pilot uninstall-agents --scope=user|project\n",
    );
    return 1;
  }

  const result = await uninstallAgents({
    scope: scopeArg,
    projectRoot: opts?.projectRoot ?? process.cwd(),
    homeDir: opts?.homeDir ?? homedir(),
  });

  if (result.removed.length > 0) {
    const plural = result.removed.length === 1 ? "agent" : "agents";
    process.stderr.write(
      `[token-pilot] Removed ${result.removed.length} ${plural} from ${result.targetDir}.\n`,
    );
  }
  if (result.skipped.length > 0) {
    process.stderr.write(`[token-pilot] Skipped ${result.skipped.length}:\n`);
    for (const s of result.skipped) {
      process.stderr.write(`  - ${s.name}: ${s.reason}\n`);
    }
  }
  if (result.removed.length === 0 && result.skipped.length === 0) {
    process.stderr.write(
      `[token-pilot] No tp-* agents found in ${result.targetDir}.\n`,
    );
  }
  return 0;
}
