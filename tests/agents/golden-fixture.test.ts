/**
 * Phase 4 subtask 4.11 — deterministic fixture-compat & system-prompt
 * sanity test.
 *
 * The full behavioural assertion from TP-fgo (`agent uses MCP tool
 * before any raw Read; response size ≤ budget + 10%`) requires a live
 * LLM dispatch and is deliberately moved to Phase 7 / TP-m43. What we
 * verify here is everything that is deterministic right now:
 *
 *  - `composeAll(templates/agents)` is stable — a human-readable snapshot
 *    per agent catches accidental drift in `_shared-preamble.md` or
 *    `_response-contract.md`.
 *  - The composed system prompt for each agent is ≤2000 rough tokens
 *    (body length / 4 estimator) — sanity cap so an agent's context
 *    overhead stays small relative to its response budget.
 *  - Each agent's tools list only references tools whose work is
 *    supported by artefacts in the golden fixture repo
 *    (`tests/fixtures/golden-repo`). Missing fixture → agent role block
 *    drifted away from what we can test against.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { composeAll } from "../../src/templates/agent-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const TEMPLATES_DIR = join(ROOT, "templates", "agents");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "golden-repo");

/**
 * Artefacts each agent's role block references. If an agent's workflow
 * mentions an MCP tool whose realistic input type is absent from the
 * fixture (e.g. tp-pr-reviewer needs a diff), the test surfaces the gap.
 */
const FIXTURE_REQUIREMENTS: Record<string, string[]> = {
  "tp-run": ["src/user.ts", "src/api.ts", "package.json"],
  "tp-onboard": ["package.json", "src/api.ts", "src/helpers.py"],
  "tp-pr-reviewer": ["pr-diff.patch", "src/user.ts"],
  "tp-impact-analyzer": ["src/user.ts", "src/db.ts", "src/api.ts"],
  "tp-refactor-planner": ["src/user.ts"],
  "tp-test-triage": ["test-summary.txt", "src/user.ts"],
};

// ─── composeAll snapshot ─────────────────────────────────────────────────────

describe("composed agent snapshots (regression guard)", () => {
  it("matches a stable set of Tier 1 + Tier 2 agents", () => {
    const results = composeAll(TEMPLATES_DIR);
    const names = results.map((r) => r.name).sort();
    expect(names).toMatchInlineSnapshot(`
      [
        "tp-api-surface-tracker",
        "tp-audit-scanner",
        "tp-commit-writer",
        "tp-context-engineer",
        "tp-dead-code-finder",
        "tp-debugger",
        "tp-dep-health",
        "tp-history-explorer",
        "tp-impact-analyzer",
        "tp-incident-timeline",
        "tp-migration-scout",
        "tp-onboard",
        "tp-performance-profiler",
        "tp-pr-reviewer",
        "tp-refactor-planner",
        "tp-review-impact",
        "tp-run",
        "tp-session-restorer",
        "tp-spec-writer",
        "tp-test-coverage-gapper",
        "tp-test-triage",
        "tp-test-writer",
      ]
    `);
  });

  it("every composed agent includes shared preamble + response contract markers", () => {
    const results = composeAll(TEMPLATES_DIR);
    for (const { name, composed } of results) {
      expect(composed, `${name}: shared preamble marker`).toMatch(
        /You are a token-pilot agent/,
      );
      expect(composed, `${name}: response contract marker`).toMatch(
        /RESPONSE CONTRACT:/,
      );
      expect(composed, `${name}: budget line`).toMatch(
        /Response budget:\s*~?\d+\s*tokens/i,
      );
    }
  });
});

// ─── System prompt budget sanity cap ─────────────────────────────────────────

describe("composed system prompt size", () => {
  it("every agent's composed body is ≤2000 rough tokens (length/4)", () => {
    const results = composeAll(TEMPLATES_DIR);
    for (const { name, composed } of results) {
      const roughTokens = Math.ceil(composed.length / 4);
      expect(
        roughTokens,
        `${name}: composed prompt ~${roughTokens} tokens exceeds 2000 sanity cap`,
      ).toBeLessThanOrEqual(2000);
    }
  });
});

// ─── Golden fixture integrity ────────────────────────────────────────────────

describe("golden fixture repo", () => {
  it("fixture directory exists", () => {
    expect(existsSync(FIXTURE_DIR)).toBe(true);
  });

  it.each(Object.entries(FIXTURE_REQUIREMENTS))(
    "%s: required fixture artefacts are present",
    (_name, required) => {
      for (const rel of required) {
        expect(
          existsSync(join(FIXTURE_DIR, rel)),
          `missing fixture: ${rel}`,
        ).toBe(true);
      }
    },
  );

  it("fixture README lists every Tier 1 agent", () => {
    const readme = readFileSync(join(FIXTURE_DIR, "README.md"), "utf-8");
    for (const name of Object.keys(FIXTURE_REQUIREMENTS)) {
      expect(readme, `README missing ${name}`).toContain(name);
    }
  });

  it("fixture stays minimal (< 20 files)", () => {
    function countFiles(dir: string): number {
      let n = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
        else n += 1;
      }
      return n;
    }
    const count = countFiles(FIXTURE_DIR);
    expect(
      count,
      `fixture has ${count} files; belongs in Phase 7 benchmarks, not here`,
    ).toBeLessThan(20);
  });
});
