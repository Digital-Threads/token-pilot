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
import { NAV_TOOLS, EDIT_EXTRAS, type ToolProfile } from "./tool-profiles.js";

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

  // v0.45.0 (token-pilot-26b) — we NO LONGER recommend trimming to nav/edit.
  // Past tool usage doesn't predict future edits, and a trimmed profile hides
  // read_for_edit / read_range / batch reads that the rules and the pre-edit
  // hook still reference — so the agent calls them, hits "No such tool
  // available", and falls back to raw Read/Bash. That recurring trap cost two
  // users whole sessions. Full is the recommendation; minimal stays a
  // self-serve, clearly-warned opt-in for context-critical work only.
  const allInNav = [...used].every((t) => NAV_TOOLS.has(t));
  if (allInNav) {
    return {
      recommended: "full",
      reason: `You've used only nav-subset tools so far (${uniqueToolsSeen} distinct), but read_for_edit / read_range / batch reads — named by the rules and the pre-edit hook — live in edit/full. Stay on full so an edit doesn't hit "No such tool available". Set TOKEN_PILOT_PROFILE=minimal yourself ONLY if context is critically tight (it hides edit tools).`,
      uniqueToolsSeen,
      totalCalls,
      wouldHide: [],
      lowConfidence: false,
    };
  }

  const allInEditOrBelow = [...used].every(
    (t) => NAV_TOOLS.has(t) || EDIT_EXTRAS.has(t),
  );
  if (allInEditOrBelow) {
    return {
      recommended: "full",
      reason: `You use edit-prep tools but haven't reached for full-only ones (code_audit/test_summary/find_unused) yet. Stay on full — they cost ~1k tokens to advertise but trimming hides them the moment you need one, and dead calls cost more.`,
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
  // v0.45.0 (26b) — we no longer print an "apply nav/edit to .mcp.json"
  // snippet. recommendProfile always returns `full`; the old snippet trapped
  // users into trimming, which hid edit tools the rules reference.
  if (rec.lowConfidence) {
    lines.push(
      `  action:       keep default (full). Re-run \`token-pilot doctor\` after a few real sessions for a data-backed view.`,
    );
  } else {
    lines.push(
      `  action:       keep default (full). Trim to minimal yourself only for context-critical, read-only work.`,
    );
  }
  return lines.join("\n");
}
