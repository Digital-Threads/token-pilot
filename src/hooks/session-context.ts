/**
 * The text token-pilot puts in front of a session: the mandatory tool block,
 * the delegation guide filtered to installed agents, the profile banner and
 * the adoption nudge. No Node here — the SessionStart hook and the Claude
 * Code mod's system-prompt section build the same text.
 */

import type { HookEvent } from "../core/event-log.js";
import type { ToolProfile } from "../server/tool-profiles.js";

// ─── subagent adoption nudge (v0.32.0) ──────────────────────────────
// Pure function: takes the event log + current time, returns either a
// one-liner nudge string or null when there's nothing useful to say.
// Thresholds are module-level constants so tests can reference them.

const NUDGE_WINDOW_DAYS = 7;
/** Minimum Task events in window before we consider the sample big enough. */
const NUDGE_MIN_SAMPLE = 5;
/** Miss-rate (routable general-purpose dispatches / total) above which we nudge. */
const NUDGE_THRESHOLD = 0.5;

export function buildSubagentAdoptionNudge(
  events: HookEvent[],
  now: number,
  windowDays: number = NUDGE_WINDOW_DAYS,
  minSample: number = NUDGE_MIN_SAMPLE,
  threshold: number = NUDGE_THRESHOLD,
): string | null {
  const cutoff = now - windowDays * 86_400_000;
  const tasks = events.filter((e) => e.event === "task" && e.ts >= cutoff);
  if (tasks.length < minSample) return null;

  const misses = tasks.filter(
    (e) =>
      typeof e.matched_tp_agent === "string" &&
      e.matched_tp_agent.length > 0 &&
      e.subagent_type !== e.matched_tp_agent,
  );
  if (misses.length === 0) return null;

  const rate = misses.length / tasks.length;
  if (rate < threshold) return null;

  const pct = Math.round(rate * 100);
  // Surface the top routing miss pair so the nudge is concrete, not abstract.
  const pairCounts = new Map<string, number>();
  for (const m of misses) {
    const key = `${m.subagent_type} → ${m.matched_tp_agent}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const topPair = [...pairCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const pairClause = topPair ? ` Top miss: ${topPair}.` : "";
  return (
    `[token-pilot] subagent miss-rate ${pct}% over last ${windowDays}d ` +
    `(${misses.length}/${tasks.length} Task calls could have used a tp-* specialist).${pairClause} ` +
    `Run \`token-pilot stats --tasks\` for details, or set TOKEN_PILOT_FORCE_SUBAGENTS=1 to hard-block.`
  );
}

export interface AgentEntry {
  name: string;
  description: string;
}

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

// ─── Message builder (subtask 2.3) ───────────────────────────────────────────

const TOOL_LIST = `  smart_read(path)             — structural overview of a code file
  read_symbol(path, symbol)    — one function / class body
  read_for_edit(path, symbol)  — exact text for an edit's old_string
  outline(dir)                 — symbols of every file in a directory
  find_usages(symbol)          — who calls / uses a symbol (instead of grep)
  smart_diff                   — git diff structurally (instead of raw git diff)
  smart_log(path?)             — git log with symbol context (instead of raw git log)
  test_summary(command)        — test runs without dumping full output
  project_overview             — unfamiliar repo top-level map (first step)
Batch variants (prefer over loops): read_symbols, smart_read_many.
read_section — Markdown/YAML/JSON/CSV ONLY (by heading/key/row); for CODE use read_range / read_symbol.
Also available: read_range, read_diff, module_info, related_files, explore_area,
code_audit, find_unused, session_snapshot, session_budget, session_analytics.`;

const SHELL_GATE =
  "Unbounded shell dumps (cat of a code file, grep -r, git log/diff without a bound) are refused; " +
  "prefix a command with TOKEN_PILOT_BYPASS=1 to run it anyway.";

export const MANDATORY_BLOCK = `[token-pilot active]

MANDATORY — use these BEFORE whole-file Read, grep or git:
${TOOL_LIST}
A whole-file Read of a big code file returns its outline; Read with offset/limit
within the gate's limit (300 lines by default) passes. ${SHELL_GATE}`;

/** Codex has no Read tool and no tp-* agents: everything goes through the shell. */
export const CODEX_BLOCK = `[token-pilot active]

MANDATORY — use these BEFORE reading code through the shell (cat, sed, grep -r, git):
${TOOL_LIST}
${SHELL_GATE}`;

export const DECISION_GUIDE = `WHEN DELEGATING — if the task fits a specialist, dispatch it with the Agent tool:
  bug / stack trace       → tp-debugger
  PR / diff review        → tp-pr-reviewer
  impact before change    → tp-impact-analyzer
  plan refactor           → tp-refactor-planner
  failing tests           → tp-test-triage
  write new tests         → tp-test-writer
  migrate API / version   → tp-migration-scout
  "why is this like this?" → tp-history-explorer
  security / quality audit → tp-audit-scanner
  resume after /clear     → tp-session-restorer
  dead code cleanup       → tp-dead-code-finder
  commit message          → tp-commit-writer
  repo onboarding         → tp-onboard
  blast radius of a PR    → tp-review-impact
  test coverage gaps      → tp-test-coverage-gapper
  public API diff / semver → tp-api-surface-tracker
  dependency audit        → tp-dep-health
  incident post-mortem    → tp-incident-timeline
  general workhorse       → tp-run
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
  // installed, under the name they are dispatched by (a plugin's agents are
  // `token-pilot:tp-*`). Dropping lines for missing agents keeps the
  // reminder honest when the template ships an agent the user hasn't installed.
  const installed = new Map(agents.map((a) => [a.name.slice(a.name.indexOf(":") + 1), a.name]));
  const guideKnownNames = new Set<string>();
  const decisionGuideLines: string[] = [];
  for (const line of DECISION_GUIDE.split("\n")) {
    const m = line.match(/→\s+(tp-[a-z-]+)/);
    if (!m) {
      decisionGuideLines.push(line); // header / footer
      continue;
    }
    guideKnownNames.add(m[1]);
    const name = installed.get(m[1]);
    if (name) decisionGuideLines.push(line.replace(m[1], name));
  }

  // Fallback: custom / third-party tp-* agents we don't hard-code in the
  // guide still deserve a mention so the main agent can delegate to them.
  const extras = agents.filter(
    (a) => !guideKnownNames.has(a.name.slice(a.name.indexOf(":") + 1)),
  );
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
/**
 * v0.45.0 (token-pilot-2fd part 2) — when a trimmed TOOL profile is active,
 * the banner still names tools that profile hides. The full default advertises
 * everything, but an explicit nav/edit/minimal does not, so warn the agent
 * before it calls a hidden tool, hits "No such tool available", and falls back
 * to raw Read/Bash. Empty string for the default `full` profile.
 */
export function profileBannerNote(profile: ToolProfile): string {
  if (profile === "full") return "";
  return (
    `⚠ TOKEN_PILOT_PROFILE=${profile} — trimmed tool surface active. Some tools named below are NOT advertised this session ` +
    `(test_summary / code_audit / find_unused always; read_for_edit / read_range / read_diff / batch reads on nav & minimal). ` +
    `Calling them returns "No such tool available" — use the listed alternatives or unset TOKEN_PILOT_PROFILE to advertise all.\n\n`
  );
}

/** One tp-*.md file as the session reminder lists it. */
export function parseAgentEntry(fileName: string, content: string): AgentEntry {
  const fm = parseFrontmatter(content);
  return {
    name: fm.name ?? fileName.replace(/\.md$/, ""),
    description: fm.description ?? "",
  };
}

// 2h — enough to cover compaction/restart, tight enough that a new day's
// unrelated work doesn't inherit yesterday's thread.
const SNAPSHOT_FRESH_MS = 2 * 3600 * 1000;

function extractSnapshotGoal(body: string): string | null {
  const m = body.match(/\*\*Goal:\*\*\s*(.+?)(?:\n|$)/);
  return m ? m[1].trim().slice(0, 100) : null;
}

/** TP-340: point a new session at a fresh snapshot so it can resume. */
export function snapshotLine(body: string, ageMs: number): string | null {
  if (ageMs >= SNAPSHOT_FRESH_MS) return null;

  const minutes = Math.round(ageMs / 60000);
  const age = minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
  const goal = extractSnapshotGoal(body);
  const goalClause = goal ? ` (goal: "${goal}")` : "";

  return `[token-pilot] session_snapshot from ${age}${goalClause}. Read .token-pilot/snapshots/latest.md to resume — or ignore if unrelated.`;
}

/**
 * A command is ours only when it names the package AND dispatches one of
 * our `hook-*` subcommands. Matching on the package name alone flags any
 * unrelated tool whose script happens to live under a `token-pilot/`
 * checkout — which is every hook a contributor runs inside this repo.
 */
export function isTokenPilotHookCommand(command: unknown): boolean {
  const cmd = String(command ?? "");
  return cmd.includes("token-pilot") && /\bhook-[a-z-]+/.test(cmd);
}

/** token-pilot hook commands declared in one parsed settings.json. */
export function countTokenPilotHooks(settings: unknown): number {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return 0;

  let count = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of inner) {
        if (isTokenPilotHookCommand(hook?.command)) count++;
      }
    }
  }

  return count;
}

/** v0.48.0 — a token-pilot registered outside the plugin fires every hook twice. */
export function duplicateWarning(
  sources: ReadonlyArray<{ path: string; count: number }>,
): string | null {
  const total = sources.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return null;

  const where = sources.map((s) => `${s.path} (${s.count})`).join(", ");

  return (
    `[token-pilot] registered ${total} time(s) outside the plugin: ${where}. ` +
    `Claude Code runs a hook once per registration, so hooks fire repeatedly and the event log double-counts. ` +
    `Delete the token-pilot entries from those files — the plugin already provides every hook.`
  );
}
