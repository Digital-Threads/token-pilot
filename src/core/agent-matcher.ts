/**
 * v0.31.0 — tp-* subagent heuristic matcher.
 *
 * Goal: given a Claude Code `Task` tool invocation (subagent_type +
 * description), decide which `tp-*` agent from `agents/` would be a
 * better fit. Used by:
 *
 *   1. PostToolUse:Task telemetry — enrich each event with
 *      `matched_tp_agent` so `stats --tasks` can show miss-rate.
 *   2. PreToolUse:Task enforcement (Pack 2, later) — advise/deny when
 *      the agent picked `general-purpose` but a tp-* clearly fits.
 *
 * Matcher philosophy — keep it BORING and EXPLAINABLE.
 *
 * Agent frontmatter description layout (empirically stable across all
 * 24 shipped agents):
 *
 *     description: PROACTIVELY use this when the user asks to review a
 *       diff, PR, commit range, or changeset ("review these changes",
 *       "look at my PR", "is this safe to merge"). Verdict-first output
 *       with Critical / Important findings. Do NOT use for writing code
 *       or planning.
 *
 * Two signal sources:
 *
 *   - Quoted triggers: every `"…"` substring inside the description.
 *     These are literally the phrases the agent author expected users
 *     to type. Highest signal. Substring match (case-insensitive) on
 *     the user's description → score += 2.
 *
 *   - Content keywords: stemmed word set from the 1st description
 *     sentence, minus stopwords and boilerplate ("PROACTIVELY",
 *     "use this", "when the user asks"). Each match on the user's
 *     description → score += 1.
 *
 * Negative filter: everything after `Do NOT use for` is excluded from
 * keyword extraction AND actively penalises a match (score -= 1 per
 * term present in user's description). Prevents `tp-test-writer` from
 * being suggested on "diagnose failing test" (which is tp-test-triage).
 *
 * Confidence tiers:
 *   - score ≥ 3 or ≥ 1 quoted trigger → "high"
 *   - score in [1, 2]                 → "low"
 *   - score < 1                       → no match
 *
 * The function is pure (deps → in-memory index + string) so it's fully
 * unit-testable. File I/O (reading the agents dir) lives in
 * `buildAgentIndex` which is a one-shot loader called at startup.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

/** One parsed `tp-*` agent. Only fields the matcher needs. */
export interface ParsedAgent {
  /** agent name without .md extension, e.g. "tp-pr-reviewer" */
  name: string;
  /** phrases found in `"…"` inside the description — highest signal */
  quotedTriggers: string[];
  /** stemmed content keywords from the positive side of the description */
  keywords: string[];
  /** negative-filter terms from `Do NOT use for …` */
  negative: string[];
}

export interface AgentIndex {
  agents: ParsedAgent[];
}

export interface MatchResult {
  agent: string;
  confidence: "high" | "low";
  score: number;
}

/**
 * Stopwords stripped from keyword extraction. Keep tiny — aggressive
 * stopword lists kill recall. Only boilerplate from agent frontmatter
 * templates goes here.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "on",
  "at",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "with",
  "when",
  "where",
  "user",
  "users",
  "ask",
  "asks",
  "asked",
  "asking",
  "use",
  "uses",
  "used",
  "using",
  "proactively",
  "please",
  "any",
  "all",
  "some",
  "get",
  "gets",
  "got",
  "also",
  "like",
  "from",
  "into",
  "not",
  "no",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "can",
  "could",
  "should",
  "may",
  "might",
  "must",
  "you",
  "your",
  "their",
  "they",
  "them",
  "we",
  "our",
  "us",
]);

/** Extract the `description:` value from YAML frontmatter.
 *  Supports multi-line values (continuation lines indented).
 *  Returns null when the file has no frontmatter or no description. */
export function extractDescription(body: string): string | null {
  const fmEnd = body.indexOf("\n---", 3);
  if (!body.startsWith("---\n") || fmEnd === -1) return null;
  const fm = body.slice(4, fmEnd);
  const lines = fm.split("\n");

  let desc = "";
  let inDesc = false;

  for (const line of lines) {
    // Top-level key detection: `key: value` at column 0
    const topKey = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (topKey && !/^\s/.test(line)) {
      if (inDesc) break;
      if (topKey[1] === "description") {
        desc = topKey[2] ?? "";
        inDesc = true;
      }
    } else if (inDesc) {
      // Continuation line (indented or blank) — append with a space.
      desc += " " + line.trim();
    }
  }

  const trimmed = desc.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Pull every `"…"` substring out of a string. Ignores empty pairs. */
export function extractQuotedTriggers(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  for (const m of s.matchAll(re)) {
    const inner = m[1].trim().toLowerCase();
    if (inner.length > 0) out.push(inner);
  }
  return out;
}

/**
 * Split `description` around `Do NOT use for …` — everything on the
 * positive side is keyword material; everything after contributes to
 * the negative filter.
 */
export function splitAroundNegative(desc: string): {
  positive: string;
  negative: string;
} {
  // Case-insensitive split on common "Do NOT use …" lead-ins. `to` catches
  // "Do NOT use to write" (tp-test-triage); `for` / `on` / `during` / `when`
  // cover every other shipped agent. Add terms here as new forms appear.
  const re = /\bdo\s+not\s+use\s+(?:for|on|during|when|to)\b/i;
  const idx = desc.search(re);
  if (idx === -1) return { positive: desc, negative: "" };
  return {
    positive: desc.slice(0, idx),
    negative: desc.slice(idx),
  };
}

/**
 * Tokenise → lowercase → drop stopwords + ≤2 chars + quoted-trigger
 * leftovers. Keywords stay in surface form; we do not stem. Stemming
 * helps recall on English verb/noun pairs ("refactor"/"refactoring"),
 * but libraries add cost for modest gain — use substring match on the
 * user's description instead (covers most morphology).
 */
export function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  // Remove quoted phrases first (they're handled separately).
  const cleaned = text.replace(/"[^"]+"/g, " ");
  for (const raw of cleaned.toLowerCase().split(/[^a-z0-9_-]+/)) {
    const tok = raw.trim();
    // Keep short technical terms ("ci", "pr", "db", "io"). STOPWORDS already
    // filters most 1-2 char english junk ("is", "to", "on", "a"). Drop
    // single chars only — they carry ~no signal.
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

/**
 * Parse one agent markdown body into its ParsedAgent representation.
 * Returns null if frontmatter is missing / description is empty.
 */
export function parseAgent(name: string, body: string): ParsedAgent | null {
  const desc = extractDescription(body);
  if (!desc) return null;
  const { positive, negative } = splitAroundNegative(desc);
  const quotedTriggers = extractQuotedTriggers(desc);
  const keywords = extractKeywords(positive);
  // Negative terms: only the core ones (tp-* names, salient nouns).
  const negKeywords = extractKeywords(negative);
  return {
    name,
    quotedTriggers,
    keywords,
    negative: negKeywords,
  };
}

/**
 * Load every `tp-*.md` under a directory and build an in-memory index.
 * Non-tp-* files are silently skipped. Unreadable files are skipped
 * with no throw — an agent directory isn't a runtime dep.
 */
export async function buildAgentIndex(agentsDir: string): Promise<AgentIndex> {
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return { agents: [] };
  }
  const agents: ParsedAgent[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("tp-") || !entry.endsWith(".md")) continue;
    const name = entry.slice(0, -".md".length);
    let body: string;
    try {
      body = await fs.readFile(join(agentsDir, entry), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseAgent(name, body);
    if (parsed) agents.push(parsed);
  }
  return { agents };
}

/**
 * Score a single agent against the user description. Surface the score
 * so callers can inspect / threshold differently if needed.
 */
export function scoreAgent(
  agent: ParsedAgent,
  userDescriptionLower: string,
): number {
  let score = 0;

  for (const trigger of agent.quotedTriggers) {
    if (userDescriptionLower.includes(trigger)) score += 2;
  }

  for (const kw of agent.keywords) {
    if (userDescriptionLower.includes(kw)) score += 1;
  }

  for (const neg of agent.negative) {
    if (userDescriptionLower.includes(neg)) score -= 1;
  }

  return score;
}

/**
 * Find the best `tp-*` match for a user description. Returns null when
 * no agent clears the low-confidence threshold.
 *
 * "Best" = highest score, tiebreak alphabetical (deterministic).
 */
export function matchTpAgent(
  description: string,
  index: AgentIndex,
): MatchResult | null {
  if (!description || index.agents.length === 0) return null;
  const needle = description.toLowerCase();

  let best: { agent: ParsedAgent; score: number } | null = null;
  for (const agent of index.agents) {
    const score = scoreAgent(agent, needle);
    if (!best) {
      best = { agent, score };
      continue;
    }
    if (score > best.score) {
      best = { agent, score };
      continue;
    }
    // Deterministic tiebreak: alphabetical by agent.name. Without this,
    // match depends on readdir order, which is filesystem-specific.
    if (score === best.score && agent.name < best.agent.name) {
      best = { agent, score };
    }
  }

  if (!best || best.score < 1) return null;

  // High confidence when score is strong OR at least one quoted trigger
  // matched (quoted = explicit author-blessed phrase).
  const hitQuoted = best.agent.quotedTriggers.some((t) => needle.includes(t));
  const confidence: "high" | "low" =
    best.score >= 3 || hitQuoted ? "high" : "low";

  return {
    agent: best.agent.name,
    confidence,
    score: best.score,
  };
}
