/**
 * bless-agents CLI (subtasks 3.4 + 3.5).
 *
 * Given a Category-C ScannedAgent:
 *  - Reads upstream file
 *  - Extends tools list with the 6 mcp__token-pilot__* tool names
 *  - Adds token_pilot frontmatter block with blessed marker
 *  - Copies upstream body verbatim
 *  - Writes atomically to ./.claude/agents/<name>.md
 *
 * Never overwrites a file without blessed:true unless --force.
 * Never overwrites a user prior customisation (file without marker).
 */

import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { parseFrontmatter, writeFrontmatter } from "./agent-frontmatter.js";
import type { ScannedAgent } from "./scan-agents.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const TP_MCP_TOOLS = [
  "mcp__token-pilot__smart_read",
  "mcp__token-pilot__read_symbol",
  "mcp__token-pilot__read_for_edit",
  "mcp__token-pilot__outline",
  "mcp__token-pilot__find_usages",
  "mcp__token-pilot__explore_area",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BlessOptions {
  projectRoot: string;
  tokenPilotVersion: string;
  force: boolean;
  dryRun: boolean;
}

export type BlessResult =
  | { kind: "blessed"; destPath: string }
  | { kind: "skipped"; reason: string }
  | { kind: "dry-run"; destPath: string }
  | { kind: "error"; reason: string };

export interface BlessSummary {
  blessed: number;
  skipped: number;
  errors: number;
}

// ─── Core: blessAgent ─────────────────────────────────────────────────────────

/**
 * Bless a single Category-C agent.
 * Reads upstream file, builds new frontmatter + body, writes atomically.
 */
export async function blessAgent(
  agent: ScannedAgent,
  opts: BlessOptions,
): Promise<BlessResult> {
  const destPath = join(
    opts.projectRoot,
    ".claude",
    "agents",
    `${agent.name}.md`,
  );

  // ── Check destination ──────────────────────────────────────────────────────
  let destExists = false;
  try {
    await access(destPath);
    destExists = true;
  } catch {
    destExists = false;
  }

  if (destExists) {
    let destContent: string;
    try {
      destContent = await readFile(destPath, "utf-8");
    } catch (err) {
      return {
        kind: "error",
        reason: `Cannot read existing destination: ${err instanceof Error ? err.message : err}`,
      };
    }

    const { meta: destMeta } = parseFrontmatter(destContent);
    const isOurBlessed =
      destMeta.token_pilot !== null &&
      typeof destMeta.token_pilot === "object" &&
      destMeta.token_pilot.blessed === true;

    if (isOurBlessed && !opts.force) {
      return {
        kind: "skipped",
        reason: `already blessed — use --force to re-bless`,
      };
    }

    if (!isOurBlessed) {
      // Exists without our marker → user's prior customisation → always skip
      return {
        kind: "skipped",
        reason: `prior customisation exists without blessed marker — skipping to respect user override`,
      };
    }
    // isOurBlessed && force → fall through to overwrite
  }

  // ── Read upstream ──────────────────────────────────────────────────────────
  let upstreamContent: string;
  try {
    upstreamContent = await readFile(agent.path, "utf-8");
  } catch (err) {
    return {
      kind: "error",
      reason: `Cannot read upstream file ${agent.path}: ${err instanceof Error ? err.message : err}`,
    };
  }

  const { meta: upstreamMeta, body: upstreamBody } =
    parseFrontmatter(upstreamContent);

  // ── Build new tools list ───────────────────────────────────────────────────
  // Start from the upstream tools (may be string or array), add TP tools
  let existingTools: string[] = [];

  if (Array.isArray(upstreamMeta.tools)) {
    existingTools = (upstreamMeta.tools as string[]).map((t) =>
      String(t).trim(),
    );
  } else if (typeof upstreamMeta.tools === "string") {
    existingTools = upstreamMeta.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // De-duplicate: add only missing TP tools
  const newTools = [...existingTools];
  for (const t of TP_MCP_TOOLS) {
    if (!newTools.includes(t)) {
      newTools.push(t);
    }
  }

  // ── Compute upstream hash ─────────────────────────────────────────────────
  const upstreamHash = createHash("sha256")
    .update(upstreamContent)
    .digest("hex");

  // ── Build new meta ─────────────────────────────────────────────────────────
  const newMeta: Record<string, any> = {
    name: upstreamMeta.name ?? agent.name,
    description: upstreamMeta.description ?? agent.description,
    tools: newTools,
    token_pilot: {
      blessed: true,
      upstream: agent.scope,
      blessed_at: new Date().toISOString(),
      token_pilot_version: opts.tokenPilotVersion,
      upstream_hash: upstreamHash,
    },
  };

  // ── Dry run ────────────────────────────────────────────────────────────────
  if (opts.dryRun) {
    return { kind: "dry-run", destPath };
  }

  // ── Write atomically ───────────────────────────────────────────────────────
  const newContent = writeFrontmatter({ meta: newMeta, body: upstreamBody });
  const destDir = dirname(destPath);
  await mkdir(destDir, { recursive: true });

  const tmpPath = `${destPath}.tmp-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmpPath, newContent, "utf-8");
    await rename(tmpPath, destPath);
  } catch (err) {
    // Clean up tmp on failure
    try {
      await writeFile(tmpPath, ""); // truncate so rename can't partially exist
    } catch {
      // ignore
    }
    return {
      kind: "error",
      reason: `Write failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  return { kind: "blessed", destPath };
}

// ─── blessAll ─────────────────────────────────────────────────────────────────

/**
 * Bless a list of agents and print a summary to stderr.
 */
export async function blessAll(
  agents: ScannedAgent[],
  opts: BlessOptions,
): Promise<BlessSummary> {
  const summary: BlessSummary = { blessed: 0, skipped: 0, errors: 0 };

  for (const agent of agents) {
    const result = await blessAgent(agent, opts);
    switch (result.kind) {
      case "blessed":
        summary.blessed++;
        break;
      case "skipped":
      case "dry-run":
        summary.skipped++;
        break;
      case "error":
        summary.errors++;
        process.stderr.write(
          `token-pilot bless-agents: error on ${agent.name}: ${result.reason}\n`,
        );
        break;
    }
  }

  if (!opts.dryRun) {
    process.stderr.write(
      `Blessed ${summary.blessed} agent${summary.blessed === 1 ? "" : "s"} to .claude/agents/. Start a new Claude Code session to pick them up.\n`,
    );
  }

  return summary;
}

// ─── Interactive prompt (subtask 3.5) ─────────────────────────────────────────

export type PromptChoice = "all" | "interactive" | "no";

/**
 * Present the classified list and ask the user what to do.
 * Returns the choice or throws if stdin is not a TTY without --auto.
 */
export async function promptBlessChoice(
  candidates: ScannedAgent[],
): Promise<PromptChoice> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "Run with --auto to install non-interactively, or from a TTY.\n",
    );
    process.exit(1);
  }

  process.stderr.write(`\nFound ${candidates.length} agent(s) to bless:\n`);
  for (const a of candidates) {
    process.stderr.write(`  - ${a.name} (${a.scope})\n`);
  }
  process.stderr.write(
    "\nCreate project-level overrides with MCP tools added?\n",
  );
  process.stderr.write(
    "  [a] Yes, all\n  [i] Interactive (ask per agent)\n  [n] No, cancel\n\n> ",
  );

  return new Promise<PromptChoice>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question("", (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "a" || a === "all") resolve("all");
      else if (a === "i" || a === "interactive") resolve("interactive");
      else resolve("no");
    });
  });
}

/**
 * Interactive mode: ask per-agent.
 * Returns list of agents the user confirmed.
 */
export async function promptInteractive(
  candidates: ScannedAgent[],
): Promise<ScannedAgent[]> {
  const chosen: ScannedAgent[] = [];

  for (const agent of candidates) {
    const answer = await new Promise<string>((resolve) => {
      process.stderr.write(`Bless ${agent.name} (${agent.scope})? [y/n] `);
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      rl.question("", (a) => {
        rl.close();
        resolve(a.trim().toLowerCase());
      });
    });

    if (answer === "y" || answer === "yes") {
      chosen.push(agent);
    }
  }

  return chosen;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

/**
 * Main entry for `token-pilot bless-agents` command.
 * Called from src/index.ts — delegates scanning + blessing.
 */
export async function handleBlessAgents(argv: string[]): Promise<void> {
  const { scanAgents, classifyAgent } = await import("./scan-agents.js");
  const { homedir } = await import("node:os");
  const { existsSync } = await import("node:fs");

  const auto = argv.includes("--auto");
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const homeDir = homedir();
  const projectRoot = process.cwd();

  // Derive token-pilot version from package.json
  let tpVersion = "0.0.0";
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(await readFile(pkgPath.pathname, "utf-8")) as {
      version: string;
    };
    tpVersion = pkg.version;
  } catch {
    // fallback
  }

  // Build plugin cache globs
  const pluginCacheBase = join(homeDir, ".claude", "plugins", "cache");
  const pluginCacheGlob = existsSync(pluginCacheBase)
    ? [`${pluginCacheBase}/**/agents/*.md`]
    : [];

  let agents;
  try {
    agents = await scanAgents({ projectRoot, homeDir, pluginCacheGlob });
  } catch (err) {
    process.stderr.write(
      `token-pilot bless-agents: scan failed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  // Filter to Category-C candidates only
  const candidates = agents.filter((a) => classifyAgent(a) === "C");

  if (candidates.length === 0) {
    process.stderr.write(
      "No Category-C agents found. All agents already have token-pilot MCP access or no agents are installed.\n",
    );
    process.exit(0);
  }

  const opts: BlessOptions = {
    projectRoot,
    tokenPilotVersion: tpVersion,
    force,
    dryRun,
  };

  let toProcess = candidates;

  if (!auto) {
    // Interactive or TTY check
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "Run with --auto to install non-interactively, or from a TTY.\n",
      );
      process.exit(1);
    }

    const choice = await promptBlessChoice(candidates);
    if (choice === "no") {
      process.stderr.write("Cancelled.\n");
      process.exit(0);
    }
    if (choice === "interactive") {
      toProcess = await promptInteractive(candidates);
      if (toProcess.length === 0) {
        process.stderr.write("No agents selected.\n");
        process.exit(0);
      }
    }
  }

  const summary = await blessAll(toProcess, opts);

  if (summary.errors > 0) {
    process.exit(1);
  }
}
