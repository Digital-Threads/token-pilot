/**
 * Agent scanner + classifier (subtasks 3.2 + 3.3).
 *
 * Discovers agent .md files from three locations:
 *   1. project .claude/agents/**\/*.md  (scope: 'project')
 *   2. user   ~/.claude/agents/**\/*.md  (scope: 'user')
 *   3. plugin-contributed agents         (scope: 'plugin')
 *
 * For each file: parses frontmatter, computes body hash, returns a ScannedAgent.
 * Never throws — bad/unreadable files are skipped with a one-line stderr note.
 * Symlinks pointing outside the scope's nominal root are skipped.
 */

import { readFile, lstat, realpath, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import {
  parseFrontmatter,
  parseToolsField,
  type ParsedTools,
} from "./agent-frontmatter.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentScope = "project" | "user" | "plugin";
export type AgentCategory = "A" | "B" | "C";

export interface ScannedAgent {
  name: string;
  path: string;
  scope: AgentScope;
  tools: ParsedTools;
  description: string;
  bodyHash: string;
  blessed: boolean;
}

export interface ScanOptions {
  projectRoot: string;
  homeDir: string;
  /** Pre-resolved glob patterns for plugin agent files (e.g. from ~/.claude/plugins/cache). */
  pluginCacheGlob: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Recursively list all *.md files under a directory.
 * Returns absolute paths. Returns [] if the directory doesn't exist.
 */
async function listMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const name = entry.name as string;
    const fullPath = join(dir, name);
    if (entry.isDirectory()) {
      const nested = await listMdFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && name.endsWith(".md")) {
      results.push(fullPath);
    }
    // Skip symlinks entirely at this level — handled per-file below
  }
  return results;
}

/**
 * Expand glob patterns (supporting only the trailing `*.md` form used for
 * plugin cache paths). For patterns without wildcards the path is treated
 * literally. Never throws.
 */
async function resolveGlobs(patterns: string[]): Promise<string[]> {
  const results: string[] = [];

  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      // Literal file path
      try {
        const stat = await lstat(pattern);
        if (stat.isFile()) results.push(resolve(pattern));
      } catch {
        // ignore missing
      }
      continue;
    }

    // Only handle trailing `*.md` glob (the only form used for plugin dirs)
    const starIdx = pattern.indexOf("*");
    const dir = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1); // e.g. ".md"

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir.replace(/\/$/, ""), {
        withFileTypes: true,
        encoding: "utf-8",
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name as string;
      if (entry.isFile() && name.endsWith(suffix)) {
        results.push(resolve(join(dir.replace(/\/$/, ""), name)));
      }
    }
  }

  return results;
}

/**
 * Check whether filePath is a symlink that resolves outside of rootDir.
 * Returns true if the file should be skipped.
 */
async function isSymlinkOutsideRoot(
  filePath: string,
  rootDir: string,
): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;

  try {
    const real = await realpath(filePath);
    const normalRoot = resolve(rootDir) + "/";
    return !real.startsWith(normalRoot);
  } catch {
    // If we can't resolve, skip it to be safe
    return true;
  }
}

/**
 * Parse one agent file. Returns a ScannedAgent or null if the file should be
 * skipped (parse failure, missing name, symlink outside root).
 */
async function parseAgentFile(
  filePath: string,
  scope: AgentScope,
  scopeRoot: string,
): Promise<ScannedAgent | null> {
  // Symlink guard
  if (await isSymlinkOutsideRoot(filePath, scopeRoot)) {
    return null;
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    process.stderr.write(
      `token-pilot scan-agents: skipping ${filePath}: ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }

  const { meta, body } = parseFrontmatter(content);

  // Must have a name
  const name: string =
    typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim()
      : basename(filePath, ".md");

  // If body is empty AND no name in frontmatter AND no description, it's likely
  // a file with no frontmatter at all — skip it
  if (!meta.name && !meta.description && body === content) {
    process.stderr.write(
      `token-pilot scan-agents: skipping ${filePath}: no frontmatter found\n`,
    );
    return null;
  }

  const tools = parseToolsField(meta.tools as string | string[] | undefined);
  const description =
    typeof meta.description === "string" ? meta.description : "";
  const bodyHash = sha256(body);

  // blessed: check token_pilot.blessed === true (explicit marker, not substring)
  const blessed =
    meta.token_pilot !== null &&
    typeof meta.token_pilot === "object" &&
    meta.token_pilot.blessed === true;

  return {
    name,
    path: filePath,
    scope,
    tools,
    description,
    bodyHash,
    blessed,
  };
}

// ─── scanAgents ───────────────────────────────────────────────────────────────

/**
 * Scan all agent directories and return parsed ScannedAgent entries.
 * Never throws.
 */
export async function scanAgents(opts: ScanOptions): Promise<ScannedAgent[]> {
  const results: ScannedAgent[] = [];

  // 1. Project .claude/agents/
  const projectAgentsDir = join(opts.projectRoot, ".claude", "agents");
  const projectFiles = await listMdFiles(projectAgentsDir);
  for (const filePath of projectFiles) {
    const agent = await parseAgentFile(filePath, "project", projectAgentsDir);
    if (agent) results.push(agent);
  }

  // 2. User ~/.claude/agents/
  const userAgentsDir = join(opts.homeDir, ".claude", "agents");
  const userFiles = await listMdFiles(userAgentsDir);
  for (const filePath of userFiles) {
    const agent = await parseAgentFile(filePath, "user", userAgentsDir);
    if (agent) results.push(agent);
  }

  // 3. Plugin cache globs
  const pluginFiles = await resolveGlobs(opts.pluginCacheGlob);
  for (const filePath of pluginFiles) {
    // For plugin files, use the file's parent directory as the scope root
    const pluginRoot = resolve(filePath, "..");
    const agent = await parseAgentFile(filePath, "plugin", pluginRoot);
    if (agent) results.push(agent);
  }

  return results;
}

// ─── classifyAgent ────────────────────────────────────────────────────────────

const TP_PREFIX = "mcp__token-pilot__";

function hasTokenPilotTool(tools: string[]): boolean {
  return tools.some((t) => t.startsWith(TP_PREFIX));
}

/**
 * Classify an agent by its tools field.
 *
 * A — wildcard (tools: * | All tools) → already has MCP access
 * A — explicit list that already contains mcp__token-pilot__* → already has access
 * B — exclusion form where mcp__token-pilot__ is NOT excluded → has access
 * C — explicit list without mcp__token-pilot__* → candidate for blessing
 * C — exclusion form that explicitly excludes mcp__token-pilot__* → needs blessing
 */
export function classifyAgent(agent: ScannedAgent): AgentCategory {
  const { tools } = agent;

  switch (tools.kind) {
    case "wildcard":
      return "A";

    case "exclusion": {
      // If the exclusion list mentions mcp__token-pilot__ → agent lacks access
      const excludesTP = tools.excluded.some((e) => e.startsWith(TP_PREFIX));
      return excludesTP ? "C" : "B";
    }

    case "explicit": {
      // If the explicit list already contains mcp__token-pilot__ → treat as A
      if (hasTokenPilotTool(tools.tools)) return "A";
      // Otherwise it's a restricted list → C candidate
      return "C";
    }
  }
}
