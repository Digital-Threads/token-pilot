/**
 * Tests for agent-matcher.
 *
 * Covers parser (frontmatter → ParsedAgent), scoring (quoted + keyword
 * + negative), and top-level matchTpAgent over a small fixture index.
 * File I/O path is exercised only lightly — the pure functions carry
 * the risk, so they get the bulk of the coverage.
 */
import { describe, expect, it } from "vitest";
import {
  buildAgentIndex,
  extractDescription,
  extractKeywords,
  extractQuotedTriggers,
  matchTpAgent,
  parseAgent,
  scoreAgent,
  splitAroundNegative,
  type AgentIndex,
  type ParsedAgent,
} from "../../src/core/agent-matcher.ts";

// Real-format frontmatter sampled from shipped agents, trimmed to
// essentials. Parser must handle multi-line descriptions with
// continuation indent.
const PR_REVIEWER_BODY = `---
name: tp-pr-reviewer
description: PROACTIVELY use this when the user asks to review a diff, PR, commit range, or changeset ("review these changes", "look at my PR", "is this safe to merge"). Verdict-first output with Critical / Important findings. Do NOT use for writing code or planning.
tools:
  - mcp__token-pilot__smart_diff
model: sonnet
---

Body here.
`;

const TEST_WRITER_BODY = `---
name: tp-test-writer
description: PROACTIVELY use this when the user asks to write, add, or cover a SPECIFIC function / method / class with tests ("add test for X", "cover Y"). Mirrors project's existing test style. Do NOT use for diagnosing failures (that's tp-test-triage).
tools:
  - mcp__token-pilot__read_symbol
model: sonnet
---
`;

const TEST_TRIAGE_BODY = `---
name: tp-test-triage
description: PROACTIVELY use this when the user reports failing tests, asks to investigate a red CI, or says "these tests are broken / flaky". Identifies root cause and suggests minimal fix — no speculation. Do NOT use to write new tests (that's tp-test-writer).
tools:
  - mcp__token-pilot__test_summary
model: sonnet
---
`;

describe("extractDescription", () => {
  it("pulls description from real frontmatter", () => {
    const d = extractDescription(PR_REVIEWER_BODY);
    expect(d).toContain("PROACTIVELY");
    expect(d).toContain("review these changes");
    expect(d).toContain("Do NOT use");
  });

  it("returns null when frontmatter missing", () => {
    expect(extractDescription("body only")).toBeNull();
  });

  it("returns null when description key absent", () => {
    expect(extractDescription("---\nname: foo\n---\n")).toBeNull();
  });
});

describe("extractQuotedTriggers", () => {
  it("pulls phrases from real description", () => {
    const d = extractDescription(PR_REVIEWER_BODY)!;
    const triggers = extractQuotedTriggers(d);
    expect(triggers).toContain("review these changes");
    expect(triggers).toContain("look at my pr");
    expect(triggers).toContain("is this safe to merge");
  });

  it("returns empty list when there are no quotes", () => {
    expect(extractQuotedTriggers("no quotes here")).toEqual([]);
  });

  it("extracts multiple quoted phrases, lowercased + trimmed", () => {
    expect(extractQuotedTriggers('say "Hi" and "Bye  "')).toEqual([
      "hi",
      "bye",
    ]);
  });
});

describe("splitAroundNegative", () => {
  it("splits on 'Do NOT use for'", () => {
    const { positive, negative } = splitAroundNegative(
      "Do X. Do NOT use for Y.",
    );
    expect(positive).toBe("Do X. ");
    expect(negative).toContain("Y");
  });

  it("handles 'Do NOT use during'", () => {
    const { positive, negative } = splitAroundNegative(
      "Plan this. Do NOT use during the migration.",
    );
    expect(positive.trim()).toBe("Plan this.");
    expect(negative.toLowerCase()).toContain("migration");
  });

  it("returns full string as positive when no negative clause", () => {
    const { positive, negative } = splitAroundNegative("Only positive text.");
    expect(positive).toBe("Only positive text.");
    expect(negative).toBe("");
  });
});

describe("extractKeywords", () => {
  it("strips stopwords and short tokens", () => {
    const kws = extractKeywords("The user asks to refactor the API");
    expect(kws).toContain("refactor");
    expect(kws).toContain("api");
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("to");
  });

  it("removes quoted phrases before tokenising", () => {
    const kws = extractKeywords('write tests "add test for X" quickly');
    // "X" would survive as a token otherwise — it must NOT.
    expect(kws).not.toContain("x");
    expect(kws).toContain("write");
    expect(kws).toContain("tests");
    expect(kws).toContain("quickly");
  });
});

describe("parseAgent", () => {
  it("returns ParsedAgent with triggers, keywords, negatives", () => {
    const a = parseAgent("tp-pr-reviewer", PR_REVIEWER_BODY)!;
    expect(a.name).toBe("tp-pr-reviewer");
    expect(a.quotedTriggers).toContain("review these changes");
    expect(a.keywords).toContain("diff");
    expect(a.keywords).toContain("review");
    // Negative side should pick up terms from "Do NOT use for …"
    expect(a.negative).toContain("writing");
  });

  it("returns null for body without frontmatter", () => {
    expect(parseAgent("tp-x", "just a body")).toBeNull();
  });
});

// --------------------------------------------------------------------
// Scoring + matching
// --------------------------------------------------------------------

function idx(...agents: ParsedAgent[]): AgentIndex {
  return { agents };
}

const prReviewer = parseAgent("tp-pr-reviewer", PR_REVIEWER_BODY)!;
const testWriter = parseAgent("tp-test-writer", TEST_WRITER_BODY)!;
const testTriage = parseAgent("tp-test-triage", TEST_TRIAGE_BODY)!;

describe("scoreAgent", () => {
  it("boosts heavily on quoted trigger match (substring, case-insensitive)", () => {
    const score = scoreAgent(prReviewer, "please review these changes");
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it("accumulates keyword matches", () => {
    const noKw = scoreAgent(prReviewer, "hello world");
    const withKw = scoreAgent(prReviewer, "review a diff changeset");
    expect(withKw).toBeGreaterThan(noKw);
  });

  it("penalises when user description hits negative terms", () => {
    // tp-test-writer negatives include "diagnosing", "failures"
    const plain = scoreAgent(testWriter, "write tests");
    const withNeg = scoreAgent(
      testWriter,
      "write tests and diagnosing failures",
    );
    expect(withNeg).toBeLessThan(plain);
  });
});

describe("matchTpAgent", () => {
  const index = idx(prReviewer, testWriter, testTriage);

  it("matches tp-pr-reviewer on quoted trigger phrase", () => {
    const r = matchTpAgent('please "review these changes" on my PR', index);
    expect(r?.agent).toBe("tp-pr-reviewer");
    expect(r?.confidence).toBe("high");
  });

  it("prefers tp-test-writer for 'add test for X'", () => {
    const r = matchTpAgent("add test for login function", index);
    expect(r?.agent).toBe("tp-test-writer");
    expect(r?.confidence).toBe("high");
  });

  it("prefers tp-test-triage over tp-test-writer for 'diagnose failing tests'", () => {
    // Writer penalises on "diagnosing/failures", triage wins.
    const r = matchTpAgent("diagnose failing tests flaky in CI", index);
    expect(r?.agent).toBe("tp-test-triage");
  });

  it("returns null for unrelated description", () => {
    expect(matchTpAgent("reminder to buy milk", index)).toBeNull();
  });

  it("returns null on empty description or empty index", () => {
    expect(matchTpAgent("", index)).toBeNull();
    expect(matchTpAgent("anything", { agents: [] })).toBeNull();
  });

  it("low confidence when only weak keyword signal", () => {
    // "review" alone (no quoted trigger, low total score) → low conf.
    const r = matchTpAgent("review", index);
    // Either null (score < 1) or low — both acceptable for weak signal.
    if (r) expect(r.confidence).toBe("low");
  });
});

describe("buildAgentIndex", () => {
  it("returns empty index for missing directory", async () => {
    const out = await buildAgentIndex("/nonexistent/path/foo/bar/baz");
    expect(out.agents).toEqual([]);
  });

  it("reads the real agents/ dir (smoke test on shipped agents)", async () => {
    // Absolute path inside the repo — sanity check that the 24 shipped
    // agents parse cleanly and all appear.
    const { default: path } = await import("node:path");
    const dir = path.resolve(__dirname, "..", "..", "agents");
    const out = await buildAgentIndex(dir);
    // Expect at least 20 agents (we ship 24, allow drift).
    expect(out.agents.length).toBeGreaterThanOrEqual(20);
    // Every parsed agent has a name starting with tp-.
    for (const a of out.agents) expect(a.name.startsWith("tp-")).toBe(true);
    // tp-pr-reviewer should be there and have at least one quoted trigger.
    const pr = out.agents.find((a) => a.name === "tp-pr-reviewer");
    expect(pr).toBeDefined();
    expect(pr!.quotedTriggers.length).toBeGreaterThan(0);
  });
});
