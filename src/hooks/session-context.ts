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

/**
 * A tp-*.md an older token-pilot installed: it carries the install marker,
 * exactly what `uninstall-agents` removes. token-pilot no longer ships
 * subagents, so each copy only adds its description to every session.
 */
export function isLegacyAgent(body: string): boolean {
  return /^token_pilot_body_hash:\s*\S/m.test(body);
}

/** One note for the person about leftover agent copies, or null when there are none. */
export function legacyAgentsWarning(
  found: ReadonlyArray<{ dir: string; count: number; scope: "user" | "project" }>,
  claudeConfigDir?: string,
): string | null {
  const dirs = found.filter((f) => f.count > 0);
  if (dirs.length === 0) return null;

  // The person runs the command in a terminal that may not carry
  // CLAUDE_CONFIG_DIR; it has to name the folder this session reads.
  const prefix = (scope: string) => (scope === "user" && claudeConfigDir ? `CLAUDE_CONFIG_DIR=${claudeConfigDir} ` : "");
  const where = dirs.map((f) => `${f.count} tp-*.md in ${f.dir}`).join(", ");
  const remove = dirs
    .map((f) => `${prefix(f.scope)}npx token-pilot uninstall-agents --scope=${f.scope}`)
    .join(" and ");

  return (
    `[token-pilot] ${where}: copies an older version installed. token-pilot no longer ships subagents, ` +
    `and each copy adds its description to every session. Remove them with ${remove}.`
  );
}

/** SessionStart output for the bootstrap hints: they are the person's to act on. */
export function bootstrapOutput(hints: readonly string[]): string | null {
  if (hints.length === 0) return null;

  return JSON.stringify({ systemMessage: `[token-pilot] bootstrap notes:\n  - ${hints.join("\n  - ")}` });
}
