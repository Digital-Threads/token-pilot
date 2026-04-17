/**
 * SessionStart reminder hook — Component 2 of the enforcement layer.
 *
 * On every session start / /clear / /compact, emits a compact additionalContext
 * block containing the mandatory-tool rules and a list of tp-* subagents found
 * in the project and user agent directories.
 *
 * Output contract: one JSON line on stdout, or exit 0 silent.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentEntry {
  name: string;
  description: string;
}

export interface SessionStartConfig {
  enabled: boolean;
  showStats: boolean;
  maxReminderTokens: number;
}

export interface HandleSessionStartOptions {
  projectRoot: string;
  homeDir: string;
  sessionStartConfig: SessionStartConfig;
}

// ─── Agent scanner (subtask 2.2) ─────────────────────────────────────────────

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Only handles simple key: value pairs (no nested, no arrays).
 * Returns an object with extracted string fields.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return result;

  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      result[kv[1]] = kv[2].trim();
    }
  }
  return result;
}

/**
 * Scan one agents directory for tp-*.md files and return parsed entries.
 */
async function scanDir(dir: string): Promise<AgentEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const agents: AgentEntry[] = [];
  for (const filename of names) {
    if (!filename.startsWith("tp-") || !filename.endsWith(".md")) continue;
    try {
      const content = await readFile(join(dir, filename), "utf-8");
      const fm = parseFrontmatter(content);
      const stem = basename(filename, ".md");
      agents.push({
        name: fm.name ?? stem,
        description: fm.description ?? "",
      });
    } catch {
      // Skip unreadable files
    }
  }
  return agents;
}

/**
 * Scan ~/.claude/agents/ and ./.claude/agents/ for tp-*.md agent definitions.
 * Project directory takes precedence; duplicates (by name) are dropped.
 *
 * @param projectRoot - absolute path to the project root
 * @param homeDir - home directory (injected for testability; defaults to os.homedir())
 */
export async function scanAgents(
  projectRoot: string,
  homeDir: string,
): Promise<AgentEntry[]> {
  const projectAgentsDir = join(projectRoot, ".claude", "agents");
  const homeAgentsDir = join(homeDir, ".claude", "agents");

  const [projectAgents, homeAgents] = await Promise.all([
    scanDir(projectAgentsDir),
    scanDir(homeAgentsDir),
  ]);

  // Merge: project agents first; home agents fill in names not already present
  const seen = new Set<string>();
  const merged: AgentEntry[] = [];
  for (const agent of [...projectAgents, ...homeAgents]) {
    if (!seen.has(agent.name)) {
      seen.add(agent.name);
      merged.push(agent);
    }
  }
  return merged;
}

// ─── Message builder (subtask 2.3) ───────────────────────────────────────────

const MANDATORY_BLOCK = `[token-pilot active]

MANDATORY — for code files, use these before raw Read:
  mcp__token-pilot__smart_read(path)        — structural overview
  mcp__token-pilot__read_symbol(path, sym)  — one function / class
  mcp__token-pilot__read_for_edit(path, sym)— exact text for editing
  mcp__token-pilot__outline(path)           — symbol list
Raw Read allowed only with offset/limit or TOKEN_PILOT_BYPASS=1.`;

function estimateTokens(text: string): number {
  // Fast approximation: chars / 4, adjusted for whitespace
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Build the reminder message combining the mandatory-tool rules and the
 * tp-* agent list.  Enforces the maxReminderTokens budget by trimming the
 * delegating list with "… and N more" if needed.
 */
export function buildReminderMessage(
  agents: AgentEntry[],
  maxReminderTokens: number,
): string {
  const agentLines =
    agents.length === 0
      ? "  none installed — run: npx token-pilot install-agents"
      : agents.map((a) => `  ${a.name}  — ${a.description}`).join("\n");

  const delegatingSection = `WHEN DELEGATING — use the right token-pilot-native subagent:\n${agentLines}`;

  const full = `${MANDATORY_BLOCK}\n\n${delegatingSection}`;
  if (estimateTokens(full) <= maxReminderTokens) {
    return full;
  }

  // Trim agent list until we fit
  let trimmedAgents = [...agents];
  while (trimmedAgents.length > 0) {
    trimmedAgents = trimmedAgents.slice(0, trimmedAgents.length - 1);
    const dropped = agents.length - trimmedAgents.length;
    const trimmedLines =
      trimmedAgents.length === 0
        ? "  none installed — run: npx token-pilot install-agents"
        : trimmedAgents
            .map((a) => `  ${a.name}  — ${a.description}`)
            .join("\n") + `\n  … and ${dropped} more`;
    const candidate = `${MANDATORY_BLOCK}\n\nWHEN DELEGATING — use the right token-pilot-native subagent:\n${trimmedLines}`;
    if (estimateTokens(candidate) <= maxReminderTokens) {
      return candidate;
    }
  }

  // Last resort: just the mandatory block
  return MANDATORY_BLOCK;
}

// ─── Handler (subtask 2.4) ───────────────────────────────────────────────────

/**
 * Main handler for the hook-session-start CLI command.
 *
 * Returns the JSON string to write to stdout, or null for silent exit.
 * Never throws — any error → null (fail-safe pass-through).
 */
export async function handleSessionStart(
  opts: HandleSessionStartOptions,
): Promise<string | null> {
  try {
    if (!opts.sessionStartConfig.enabled) {
      return null;
    }

    const agents = await scanAgents(opts.projectRoot, opts.homeDir);
    const message = buildReminderMessage(
      agents,
      opts.sessionStartConfig.maxReminderTokens,
    );

    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
      },
    };

    return JSON.stringify(output);
  } catch {
    // Fail-safe: never block the session
    return null;
  }
}
