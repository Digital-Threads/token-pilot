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
  /** v0.31.0 — Task-routing view: subagent_type usage + miss-rate. */
  tasks?: boolean;
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

  if (opts.tasks) {
    // v0.31.0 — Task-routing view. Scope to event:"task" records only.
    const taskEvents = scope.filter((e) => e.event === "task");
    if (taskEvents.length === 0) {
      return lines[0] + "\n\nNo Task events yet.";
    }
    const totalTasks = taskEvents.length;
    const misses = taskEvents.filter(
      (e) =>
        typeof e.matched_tp_agent === "string" &&
        e.matched_tp_agent.length > 0 &&
        e.subagent_type !== e.matched_tp_agent,
    );
    const missRate =
      totalTasks > 0 ? Math.round((misses.length / totalTasks) * 100) : 0;

    // Group by subagent_type (what Claude actually picked).
    const pickGroups = groupBy(
      taskEvents,
      (e) =>
        (e.subagent_type && e.subagent_type.length > 0
          ? e.subagent_type
          : "(unknown)") as string,
    );
    const picks = [...pickGroups.entries()]
      .map(([agent, evs]) => ({ agent, count: evs.length }))
      .sort((a, b) => b.count - a.count);

    // Top missed routings: (picked → suggested) pairs with counts.
    const missCounts = new Map<string, number>();
    for (const e of misses) {
      const key = `${e.subagent_type} → ${e.matched_tp_agent}`;
      missCounts.set(key, (missCounts.get(key) ?? 0) + 1);
    }
    const topMisses = [...missCounts.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Rewrite header for the task view (replace savings number with miss-rate).
    lines[0] = `token-pilot stats — ${totalTasks} Task call${totalTasks === 1 ? "" : "s"}, miss-rate ${missRate}% (${misses.length}/${totalTasks})${sessionSuffix}`;
    lines.push("");
    lines.push("Picked subagents:");
    for (const p of picks) {
      lines.push(
        `  ${pad(p.agent, 24)}  ${p.count.toString().padStart(4)}× events`,
      );
    }
    if (topMisses.length > 0) {
      lines.push("");
      lines.push("Top routing misses (picked → suggested tp-*):");
      for (const m of topMisses) {
        lines.push(`  ${pad(m.pair, 48)}  ${m.count.toString().padStart(4)}×`);
      }
    }
  } else if (opts.byAgent) {
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
  const tasks = parseFlag(argv, "tasks");

  const rendered = formatStats(events, {
    session: session === undefined ? undefined : session,
    byAgent: byAgent === true,
    tasks: tasks === true,
  });
  process.stdout.write(rendered + "\n");
  return 0;
}
