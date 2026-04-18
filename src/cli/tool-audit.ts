/**
 * v0.26.2 — `npx token-pilot tool-audit`.
 *
 * Reads `.token-pilot/tool-calls.jsonl` + archives and emits a per-tool
 * savings distribution across every session the user has ever run. The
 * whole point is to answer "which tools actually save tokens" with
 * data, not with a single field-report session.
 *
 * Output is human-readable by default; `--json` for scripts/CI.
 * Exit code is always 0 — this is a diagnostic, not a gate. A future
 * `tool-audit --fail-below=20` could turn it into a CI signal once we
 * trust the baseline.
 */

import { loadAllToolCalls, type ToolCallEvent } from "../core/tool-call-log.js";

export interface ToolAuditRow {
  tool: string;
  count: number;
  tokensReturned: number;
  tokensWouldBe: number;
  saved: number;
  reductionPct: number;
  /** Calls where the recorder claimed NO savings (pass-through) — separate so
   *  they don't poison the reduction average. */
  noneCalls: number;
  /** True when reduction is below the low-value threshold AND we have enough
   *  samples (≥5) to make a claim — avoids flagging tools after 1 bad run. */
  lowValue: boolean;
}

/**
 * Aggregate raw events into one row per tool. Pure — tested in
 * isolation from the filesystem.
 */
export function aggregateToolCalls(
  events: ToolCallEvent[],
  lowValueThreshold = 20,
  minSamples = 5,
): ToolAuditRow[] {
  const byTool = new Map<
    string,
    {
      count: number;
      tokensReturned: number;
      tokensWouldBe: number;
      noneCalls: number;
    }
  >();

  for (const e of events) {
    const row = byTool.get(e.tool) ?? {
      count: 0,
      tokensReturned: 0,
      tokensWouldBe: 0,
      noneCalls: 0,
    };
    row.count++;
    row.tokensReturned += e.tokensReturned;
    row.tokensWouldBe += e.tokensWouldBe;
    if (e.savingsCategory === "none") row.noneCalls++;
    byTool.set(e.tool, row);
  }

  const rows: ToolAuditRow[] = [];
  for (const [tool, r] of byTool) {
    const saved = Math.max(0, r.tokensWouldBe - r.tokensReturned);
    const reductionPct =
      r.tokensWouldBe > 0
        ? Math.round((1 - r.tokensReturned / r.tokensWouldBe) * 100)
        : 0;
    const lowValue = r.count >= minSamples && reductionPct < lowValueThreshold;
    rows.push({
      tool,
      count: r.count,
      tokensReturned: r.tokensReturned,
      tokensWouldBe: r.tokensWouldBe,
      saved,
      reductionPct,
      noneCalls: r.noneCalls,
      lowValue,
    });
  }

  // Sort by tokens saved desc — the first row is your biggest
  // contributor to overall savings, low-value tools sink to the bottom.
  rows.sort((a, b) => b.saved - a.saved);
  return rows;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/**
 * Format rows as a fixed-width table for the terminal. Pure.
 */
export function formatTable(
  rows: ToolAuditRow[],
  opts: { totalEvents: number },
): string {
  if (rows.length === 0) {
    return `No tool calls recorded yet.
Run a few MCP tool calls from your AI client, then re-run \`npx token-pilot tool-audit\`.`;
  }
  const lines: string[] = [];
  lines.push(`Token Pilot — tool audit`);
  lines.push(
    `  ${opts.totalEvents} calls across ${rows.length} tools (cumulative across sessions)`,
  );
  lines.push("");
  lines.push(
    "  Tool                     Calls      Saved   Returned  Reduction",
  );
  lines.push(
    "  ─────────────────────────────────────────────────────────────────",
  );
  for (const r of rows) {
    const tool = r.tool.padEnd(24);
    const count = String(r.count).padStart(6);
    const saved = fmtTokens(r.saved).padStart(9);
    const returned = fmtTokens(r.tokensReturned).padStart(9);
    const pct = `${r.reductionPct}%`.padStart(6);
    const flag = r.lowValue ? "  ⚠ low-value" : "";
    lines.push(`  ${tool} ${count} ${saved} ${returned} ${pct}${flag}`);
  }

  const lowValueRows = rows.filter((r) => r.lowValue);
  if (lowValueRows.length > 0) {
    lines.push("");
    lines.push(
      "Low-value tools flagged above have <20% token reduction across ≥5 calls.",
    );
    lines.push(
      "Consider: check their `none` passthrough count, or whether a cheaper alternative (Grep, Read) would do the job.",
    );
  }

  return lines.join("\n");
}

export interface ToolAuditOptions {
  projectRoot: string;
  json?: boolean;
  /** For tests. */
  now?: Date;
}

export async function runToolAudit(opts: ToolAuditOptions): Promise<{
  stdout: string;
  exitCode: number;
  rows: ToolAuditRow[];
}> {
  const events = await loadAllToolCalls(opts.projectRoot);
  const rows = aggregateToolCalls(events);

  if (opts.json) {
    return {
      stdout: JSON.stringify(
        { totalEvents: events.length, tools: rows },
        null,
        2,
      ),
      exitCode: 0,
      rows,
    };
  }

  return {
    stdout: formatTable(rows, { totalEvents: events.length }),
    exitCode: 0,
    rows,
  };
}

/**
 * CLI entry. `argv` is the raw `process.argv.slice(2)` after
 * dispatching to this subcommand.
 */
export async function handleToolAudit(
  argv: string[],
  opts?: { projectRoot?: string },
): Promise<number> {
  const json = argv.includes("--json");
  const projectRoot = opts?.projectRoot ?? process.cwd();
  const { stdout, exitCode } = await runToolAudit({ projectRoot, json });
  process.stdout.write(stdout + "\n");
  return exitCode;
}
