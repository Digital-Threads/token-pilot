/**
 * v0.26.4 — data-driven profile recommendation.
 *
 * The user mandate: existing users who don't read CHANGELOG shouldn't
 * be left carrying the full 22-tool tools/list payload forever just
 * because we were afraid of a breaking default change.
 *
 * Approach: the doctor command reads cumulative .token-pilot/tool-calls.jsonl
 * (introduced in v0.26.2) and classifies the user's actual usage:
 *
 *   - Every tool they used fits in NAV_TOOLS    → recommend `nav`
 *   - Uses NAV + a subset of EDIT_EXTRAS        → recommend `edit`
 *   - Uses full-only tools (test_summary,
 *     code_audit, find_unused, session_*)      → recommend `full`
 *
 * The recommendation is *advisory*. We never auto-flip anyone's default;
 * a user running through a rare but real tool like code_audit would
 * lose it silently. Doctor prints the recommendation + the exact env
 * snippet to paste into .mcp.json, and the copy nudges the user to act.
 */

import type { ToolCallEvent } from "../core/tool-call-log.js";
import type { ToolProfile } from "./tool-profiles.js";

/** Mirror of the sets inside tool-profiles.ts — kept local to avoid
 *  exporting internal filter state. Must stay in sync; guarded by a unit
 *  test that asserts the symmetric difference is empty. */
const NAV_TOOLS: ReadonlySet<string> = new Set([
  "smart_read",
  "read_symbol",
  "outline",
  "find_usages",
  "project_overview",
  "module_info",
  "related_files",
  "explore_area",
  "smart_log",
  "smart_diff",
]);

const EDIT_EXTRAS: ReadonlySet<string> = new Set([
  "read_symbols",
  "read_range",
  "read_section",
  "read_diff",
  "read_for_edit",
  "smart_read_many",
]);

/** Below this the sample is too small to make a confident recommendation. */
const MIN_SAMPLE_CALLS = 20;

export interface ProfileRecommendation {
  /** The profile we'd pick if the user asked "what fits me?". */
  recommended: ToolProfile;
  /** One-sentence explanation printable by doctor. */
  reason: string;
  /** Number of distinct tools the user has ever called. */
  uniqueToolsSeen: number;
  /** Total calls in the log (across all sessions/projects). */
  totalCalls: number;
  /** Tools that would be filtered out under `recommended`. Empty when
   *  recommended=full. */
  wouldHide: string[];
  /** True when we don't have enough data to claim more than "full". */
  lowConfidence: boolean;
}

/**
 * Pure analysis — takes raw tool-call events, returns a recommendation.
 * Safe to unit-test without filesystem, network, or config.
 */
export function recommendProfile(
  events: readonly ToolCallEvent[],
): ProfileRecommendation {
  const used = new Set<string>();
  for (const e of events) used.add(e.tool);

  const totalCalls = events.length;
  const uniqueToolsSeen = used.size;

  if (totalCalls < MIN_SAMPLE_CALLS) {
    return {
      recommended: "full",
      reason: `Only ${totalCalls} call(s) logged — need ≥${MIN_SAMPLE_CALLS} to recommend a narrower profile.`,
      uniqueToolsSeen,
      totalCalls,
      wouldHide: [],
      lowConfidence: true,
    };
  }

  const allInNav = [...used].every((t) => NAV_TOOLS.has(t));
  if (allInNav) {
    return {
      recommended: "nav",
      reason: `Every tool you've used (${uniqueToolsSeen} distinct) is part of the nav subset. You're a read-only explorer.`,
      uniqueToolsSeen,
      totalCalls,
      wouldHide: [
        ...[...EDIT_EXTRAS].filter((t) => !used.has(t)),
        /* full-only — we don't enumerate here, keep the list short */
      ],
      lowConfidence: false,
    };
  }

  const allInEditOrBelow = [...used].every(
    (t) => NAV_TOOLS.has(t) || EDIT_EXTRAS.has(t),
  );
  if (allInEditOrBelow) {
    return {
      recommended: "edit",
      reason: `You use edit-preparation tools (read_for_edit, batch reads) but never reach for full-only tools like code_audit/test_summary/find_unused.`,
      uniqueToolsSeen,
      totalCalls,
      wouldHide: [],
      lowConfidence: false,
    };
  }

  // Uses at least one full-only tool — stay on full.
  const fullOnlyUsed = [...used].filter(
    (t) => !NAV_TOOLS.has(t) && !EDIT_EXTRAS.has(t),
  );
  return {
    recommended: "full",
    reason: `You actually use full-only tools (${fullOnlyUsed.slice(0, 3).join(", ")}${fullOnlyUsed.length > 3 ? ", …" : ""}). Don't trim.`,
    uniqueToolsSeen,
    totalCalls,
    wouldHide: [],
    lowConfidence: false,
  };
}

/**
 * Render a doctor-style multi-line block the caller can print verbatim.
 * Pure.
 */
export function formatRecommendation(rec: ProfileRecommendation): string {
  const lines: string[] = [];
  lines.push(`── profile recommendation ──`);
  lines.push(
    `  data:         ${rec.totalCalls} calls, ${rec.uniqueToolsSeen} distinct tools`,
  );
  lines.push(`  recommend:    TOKEN_PILOT_PROFILE=${rec.recommended}`);
  lines.push(`  why:          ${rec.reason}`);
  if (rec.recommended !== "full") {
    lines.push(
      `  savings:      ~${rec.recommended === "nav" ? "2200 tokens (−54%)" : "1000 tokens (−25%)"} on every tools/list response`,
    );
    lines.push(
      `  apply:        add "env": { "TOKEN_PILOT_PROFILE": "${rec.recommended}" } to your token-pilot entry in .mcp.json`,
    );
  } else if (rec.lowConfidence) {
    lines.push(
      `  action:       keep default (full). Re-run \`token-pilot doctor\` after a few real sessions for a data-backed suggestion.`,
    );
  } else {
    lines.push(
      `  action:       keep default (full). You're using what you have.`,
    );
  }
  return lines.join("\n");
}
