/**
 * What token-pilot says at session start. On Claude Code the model gets no
 * rule block: each tool's description says when to use it. What is left is
 * a pointer to a fresh snapshot, and notes for the person (duplicate hook
 * registrations, old agent copies). Codex reads code through the shell and
 * keeps its tool block. No Node here — the SessionStart hook and the Claude
 * Code mod build the same text.
 */

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

/** Codex has no Read tool and no tp-* agents: everything goes through the shell. */
export const CODEX_BLOCK = `[token-pilot active]

MANDATORY — use these BEFORE reading code through the shell (cat, sed, grep -r, git):
${TOOL_LIST}
${SHELL_GATE}`;

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

const NPM_TOOL = "mcp__token-pilot__";
const PLUGIN_TOOL = "mcp__plugin_token-pilot_token-pilot__";

/**
 * A tp-*.md that grants only the npm server's tool names. `install-agents`
 * wrote these before agents carried both spellings; on a plugin install none
 * of their token-pilot tools resolve, and each one repeats an agent the
 * plugin already ships.
 */
export function isLegacyAgent(body: string): boolean {
  return body.includes(NPM_TOOL) && !body.includes(PLUGIN_TOOL);
}

/** One note for the person about old agent copies, or null when there are none. */
export function legacyAgentsWarning(
  found: ReadonlyArray<{ dir: string; count: number; scope: "user" | "project" }>,
): string | null {
  const dirs = found.filter((f) => f.count > 0);
  if (dirs.length === 0) return null;

  const where = dirs.map((f) => `${f.count} old tp-*.md in ${f.dir}`).join(", ");
  const remove = dirs.map((f) => `npx token-pilot uninstall-agents --scope=${f.scope}`).join(" and ");

  return (
    `[token-pilot] ${where}: they list only mcp__token-pilot__* tools, which the plugin does not provide, ` +
    `and repeat the plugin's own token-pilot:tp-* agents in every session. ` +
    `Remove them with ${remove}, or refresh them with install-agents --force if you also run token-pilot outside the plugin.`
  );
}
