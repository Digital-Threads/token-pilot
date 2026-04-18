/**
 * Phase 5 drift guard — scripts/build-agents.mjs composeAgent MUST
 * produce the same bytes as src/templates/agent-builder.ts composeAgent.
 *
 * We ship the mjs variant because build-agents runs BEFORE `tsc`, so the
 * TS module is not yet compiled. The cost of that choice is two copies
 * of the composition logic. This test makes sure they never drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeAgent as composeAgentMjs,
  stampFrontmatter,
} from "../../scripts/build-agents.mjs";
import { composeAgent as composeAgentTs } from "../../src/templates/agent-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "agents");

const SHARED = readFileSync(
  join(TEMPLATES_DIR, "_shared-preamble.md"),
  "utf-8",
);
const CONTRACT = readFileSync(
  join(TEMPLATES_DIR, "_response-contract.md"),
  "utf-8",
);
const AGENTS = [
  "tp-run",
  "tp-onboard",
  "tp-pr-reviewer",
  "tp-impact-analyzer",
  "tp-refactor-planner",
  "tp-test-triage",
];

describe("build-agents.mjs parity with src/templates/agent-builder.ts", () => {
  it.each(AGENTS)("%s composed by both paths is byte-identical", (name) => {
    const source = readFileSync(join(TEMPLATES_DIR, `${name}.md`), "utf-8");
    const fromMjs = composeAgentMjs(source, SHARED, CONTRACT);
    const fromTs = composeAgentTs(source, SHARED, CONTRACT);
    expect(fromMjs).toBe(fromTs);
  });
});

describe("build-agents.mjs stampFrontmatter", () => {
  const sample =
    "---\n" +
    "name: tp-demo\n" +
    "description: Demo.\n" +
    "---\n" +
    "Body content.\n";

  it("appends token_pilot_version and token_pilot_body_hash before closing ---", () => {
    const stamped = stampFrontmatter(sample, "9.9.9");
    expect(stamped).toMatch(/token_pilot_version:\s*"9\.9\.9"/);
    expect(stamped).toMatch(/token_pilot_body_hash:\s*[a-f0-9]{64}/);
    // Body content is unchanged.
    expect(stamped.endsWith("Body content.\n")).toBe(true);
    // Exactly two `---` delimiters.
    const dashes = stamped.match(/^---$/gm);
    expect(dashes!.length).toBe(2);
  });

  it("body_hash is stable for identical body even when frontmatter stamped twice", () => {
    const a = stampFrontmatter(sample, "1.0.0");
    const b = stampFrontmatter(sample, "2.0.0");
    const hashOf = (s: string) =>
      s.match(/token_pilot_body_hash:\s*([a-f0-9]+)/)![1];
    expect(hashOf(a)).toBe(hashOf(b));
  });
});
