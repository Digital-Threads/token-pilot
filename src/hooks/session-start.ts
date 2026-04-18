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
import { loadLatestSnapshot } from "./../handlers/session-snapshot-persist.js";

const SNAPSHOT_FRESH_MS = 2 * 3600 * 1000; // 2h — enough to cover compaction/restart, tight enough that a new day's unrelated work doesn't inherit yesterday's thread

function extractSnapshotGoal(body: string): string | null {
  const m = body.match(/\*\*Goal:\*\*\s*(.+?)(?:\n|$)/);
  return m ? m[1].trim().slice(0, 100) : null;
}

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

MANDATORY — use these BEFORE raw Read / Grep / git:
  smart_read(path)             — structural overview of a code file
  read_symbol(path, sym)       — one function / class body
  read_for_edit(path, sym)     — exact text for Edit's old_string
  outline(path)                — symbol list
  find_usages(symbol)          — who calls / uses a symbol (INSTEAD of Grep)
  smart_diff                   — git diff structurally (INSTEAD of raw git diff)
  smart_log(path?)             — git log with symbol context (INSTEAD of raw git log)
  test_summary(command)        — test runs without dumping full output
  project_overview             — unfamiliar repo top-level map (first step)
Batch variants (prefer over loops): read_symbols, smart_read_many, read_section.
Also available: read_range, read_diff, module_info, related_files, explore_area,
code_audit, find_unused, session_snapshot, session_budget, session_analytics.
Raw Read/Grep allowed only with offset/limit / narrow regex / non-code files,
or TOKEN_PILOT_BYPASS=1.`;

const DECISION_GUIDE = `WHEN DELEGATING — if the task fits a specialist, use the Task tool:
  bug / stack trace      → tp-debugger
  PR / diff review       → tp-pr-reviewer
  impact before change   → tp-impact-analyzer
  plan refactor          → tp-refactor-planner
  failing tests          → tp-test-triage
  write new tests        → tp-test-writer
  migrate API / version  → tp-migration-scout
  "why is this like this?"→ tp-history-explorer
  security / quality audit→ tp-audit-scanner
  resume after /clear    → tp-session-restorer
  dead code cleanup      → tp-dead-code-finder
  commit message         → tp-commit-writer
  repo onboarding        → tp-onboard
  general workhorse      → tp-run
Delegating keeps main-context lean; each specialist has a narrow toolset + budget.`;

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
  // If no agents installed, give the user a clear nudge; skip the
  // delegation guide since there's nothing to delegate to.
  if (agents.length === 0) {
    return `${MANDATORY_BLOCK}\n\nWHEN DELEGATING — none installed; run: npx token-pilot install-agents`;
  }

  // Filter the decision guide to the agents this user actually has
  // installed. Dropping lines for missing agents keeps the reminder
  // honest when the template ships an agent the user hasn't installed.
  const installedNames = new Set(agents.map((a) => a.name));
  const guideKnownNames = new Set<string>();
  const decisionGuideLines = DECISION_GUIDE.split("\n").filter((line) => {
    const m = line.match(/→\s+(tp-[a-z-]+)/);
    if (!m) return true; // header / footer
    guideKnownNames.add(m[1]);
    return installedNames.has(m[1]);
  });

  // Fallback: custom / third-party tp-* agents we don't hard-code in the
  // guide still deserve a mention so the main agent can delegate to them.
  const extras = agents.filter((a) => !guideKnownNames.has(a.name));
  if (extras.length > 0) {
    const extraLines = extras.map(
      (a) => `  custom: ${a.name}  — ${a.description}`,
    );
    // Insert before the "Delegating keeps..." footer.
    const footer = decisionGuideLines.pop() ?? "";
    decisionGuideLines.push(...extraLines, footer);
  }
  const decisionGuide = decisionGuideLines.join("\n");

  const full = `${MANDATORY_BLOCK}\n\n${decisionGuide}`;
  if (estimateTokens(full) <= maxReminderTokens) {
    return full;
  }

  // Budget overflow: trim decision-guide body lines from the end (keep
  // header, footer, and as many mappings as fit). Preserves the first
  // line so the agent still knows the section exists.
  const header = decisionGuideLines[0];
  const footer = decisionGuideLines[decisionGuideLines.length - 1];
  const body = decisionGuideLines.slice(1, -1);
  let kept = body.length;
  while (kept > 0) {
    kept--;
    const dropped = body.length - kept;
    const trimmedBody =
      kept === 0
        ? [`  … and ${dropped} more (reminder budget exhausted)`]
        : body.slice(0, kept).concat(`  … and ${dropped} more`);
    const candidate = `${MANDATORY_BLOCK}\n\n${[header, ...trimmedBody, footer].join("\n")}`;
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
    let message = buildReminderMessage(
      agents,
      opts.sessionStartConfig.maxReminderTokens,
    );

    // TP-340: surface a fresh snapshot so the new session can resume.
    const snap = await loadLatestSnapshot(opts.projectRoot);
    if (snap && snap.ageMs < SNAPSHOT_FRESH_MS) {
      const minutes = Math.round(snap.ageMs / 60000);
      const age =
        minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
      const goal = extractSnapshotGoal(snap.body);
      const goalClause = goal ? ` (goal: "${goal}")` : "";
      message += `\n\n[token-pilot] session_snapshot from ${age}${goalClause}. Read .token-pilot/snapshots/latest.md to resume — or ignore if unrelated.`;
    }

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
