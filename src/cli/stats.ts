/**
 * Phase 6 subtask 6.3 — `token-pilot stats` CLI.
 *
 * Reads from `<projectRoot>/.token-pilot/hook-events.jsonl` and renders
 * one of three views:
 *   - default    : totals + top files by savedTokens
 *   - --session  : events filtered to a single session_id (explicit arg
 *                  or the most recent session in the log)
 *   - --by-agent : events grouped by agent_type, sorted desc by savedTokens
 *
 * formatStats() is pure (events in → string out) so tests drive it
 * directly without touching the filesystem.
 */

import { loadEvents, type HookEvent } from "../core/event-log.js";

export interface StatsOptions {
  /**
   * `true` → pick the session_id of the most recent event.
   * `string` → filter to that specific session_id.
   * `undefined` → no session filter.
   */
  session?: boolean | string;
  byAgent?: boolean;
}

function sumSaved(events: HookEvent[]): number {
  return events.reduce((sum, e) => sum + e.savedTokens, 0);
}

function groupBy<K extends string>(
  events: HookEvent[],
  keyOf: (e: HookEvent) => K,
): Map<K, HookEvent[]> {
  const out = new Map<K, HookEvent[]>();
  for (const e of events) {
    const k = keyOf(e);
    const bucket = out.get(k);
    if (bucket) bucket.push(e);
    else out.set(k, [e]);
  }
  return out;
}

function pad(label: string, width: number): string {
  return label.length >= width
    ? label
    : label + " ".repeat(width - label.length);
}

function pickMostRecentSession(events: HookEvent[]): string | null {
  if (events.length === 0) return null;
  let latest = events[0];
  for (const e of events) if (e.ts > latest.ts) latest = e;
  return latest.session_id;
}

/**
 * Pure formatter. Takes the full event list and options; returns the
 * rendered text block. Multi-line; no trailing newline.
 */
export function formatStats(events: HookEvent[], opts: StatsOptions): string {
  let scope = events;
  let sessionLabel: string | null = null;

  // --session filter
  if (opts.session !== undefined) {
    const target =
      opts.session === true ? pickMostRecentSession(events) : opts.session;
    if (!target) {
      return "No events yet.";
    }
    sessionLabel = target;
    scope = events.filter((e) => e.session_id === target);
    if (scope.length === 0) {
      return `No events for session ${target}.`;
    }
  }

  if (scope.length === 0) {
    return "No events yet.";
  }

  const lines: string[] = [];
  const total = sumSaved(scope);
  const sessionSuffix = sessionLabel ? ` (session ${sessionLabel})` : "";
  lines.push(
    `token-pilot stats${sessionSuffix} — ${scope.length} event${scope.length === 1 ? "" : "s"}, ~${total} tokens saved`,
  );

  if (opts.byAgent) {
    // Group by agent_type (null → "main").
    const groups = groupBy(scope, (e) => (e.agent_type ?? "main") as string);
    const rows = [...groups.entries()]
      .map(([agent, evs]) => ({
        agent,
        saved: sumSaved(evs),
        count: evs.length,
      }))
      .sort((a, b) => b.saved - a.saved);
    lines.push("");
    lines.push("By agent:");
    for (const r of rows) {
      lines.push(
        `  ${pad(r.agent, 20)}  ${r.count.toString().padStart(4)}× events  ~${r.saved} tokens saved`,
      );
    }
  } else {
    // Default view: top files by savedTokens.
    const groups = groupBy(scope, (e) => e.file);
    const rows = [...groups.entries()]
      .map(([file, evs]) => ({
        file,
        saved: sumSaved(evs),
        count: evs.length,
      }))
      .sort((a, b) => b.saved - a.saved)
      .slice(0, 10);
    lines.push("");
    lines.push("Top files:");
    for (const r of rows) {
      lines.push(
        `  ${pad(r.file, 40)}  ${r.count.toString().padStart(3)}×  ~${r.saved} tokens saved`,
      );
    }
  }

  return lines.join("\n");
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

function parseFlag(argv: string[], key: string): boolean | string | undefined {
  for (const a of argv) {
    if (a === `--${key}`) return true;
    if (a.startsWith(`--${key}=`)) return a.slice(key.length + 3);
  }
  return undefined;
}

/**
 * CLI entry: `token-pilot stats [--session[=<id>]] [--by-agent]`.
 * Prints to stdout and returns exit code 0.
 */
export async function handleStats(
  argv: string[],
  opts?: { projectRoot?: string },
): Promise<number> {
  const projectRoot = opts?.projectRoot ?? process.cwd();
  const events = await loadEvents(projectRoot);

  const session = parseFlag(argv, "session");
  const byAgent = parseFlag(argv, "by-agent");

  const rendered = formatStats(events, {
    session: session === undefined ? undefined : session,
    byAgent: byAgent === true,
  });
  process.stdout.write(rendered + "\n");
  return 0;
}
