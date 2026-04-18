/**
 * Phase 4 subtask 4.12 — prompt-contract test.
 *
 * For every Tier 1 tp-* template, asserts the frontmatter/body constraints
 * from TP-816 §5.4 and TP-fgo acceptance criteria:
 *
 *  - frontmatter.name matches the file basename
 *  - frontmatter.description is non-empty, ≤160 chars, and contains no
 *    "<example>" blocks (those ship in every delegate-listing)
 *  - frontmatter.tools is an explicit list that contains at least one
 *    `mcp__token-pilot__*` entry
 *  - body declares "Response budget: ~N tokens" matching the TP-816 §5.4.9
 *    budget table
 *  - only `tp-run` uses the `PROACTIVELY` keyword in its description
 *    (TP-816 §5.4.3 — every other description uses "when" or "for")
 *  - body length ≤60 lines incl. frontmatter — agent files must stay compact
 *  - the three forbidden narration phrases never appear in the body
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  parseToolsField,
} from "../../src/cli/agent-frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "agents");

/** Tier 1 agents from TP-816 §5.4.1 with their §5.4.9 response budgets. */
const TIER1: ReadonlyArray<{ name: string; budget: number }> = [
  { name: "tp-run", budget: 800 },
  { name: "tp-onboard", budget: 600 },
  { name: "tp-pr-reviewer", budget: 600 },
  { name: "tp-impact-analyzer", budget: 400 },
  { name: "tp-refactor-planner", budget: 500 },
  { name: "tp-test-triage", budget: 500 },
];

const FORBIDDEN_NARRATION = [/\bI called\b/i, /\bI ran\b/i, /\bI looked at\b/i];

describe.each(TIER1)("template %s", ({ name, budget }) => {
  const filePath = join(TEMPLATES_DIR, `${name}.md`);

  it("file exists", () => {
    expect(existsSync(filePath)).toBe(true);
  });

  it("frontmatter name matches filename and tools include token-pilot MCP", () => {
    const md = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(md);

    expect(meta.name).toBe(name);

    const tools = parseToolsField(meta.tools as string | string[] | undefined);
    expect(tools.kind).toBe("explicit");
    if (tools.kind === "explicit") {
      const hasMcp = tools.tools.some((t) =>
        t.startsWith("mcp__token-pilot__"),
      );
      expect(
        hasMcp,
        `${name} must include at least one mcp__token-pilot__ tool`,
      ).toBe(true);
    }
  });

  it("description is task-focused, ≤160 chars, no <example> blocks", () => {
    const md = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(md);
    const desc = String(meta.description ?? "");

    expect(desc.length).toBeGreaterThan(0);
    expect(
      desc.length,
      `description must be ≤160 chars (got ${desc.length})`,
    ).toBeLessThanOrEqual(160);
    expect(desc, "description must not contain <example> blocks").not.toMatch(
      /<example>/i,
    );
  });

  it("only tp-run uses PROACTIVELY keyword", () => {
    const md = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(md);
    const desc = String(meta.description ?? "");

    if (name === "tp-run") {
      expect(desc, "tp-run must use PROACTIVELY keyword").toMatch(
        /PROACTIVELY/,
      );
    } else {
      expect(desc, `${name} must not use PROACTIVELY keyword`).not.toMatch(
        /PROACTIVELY/,
      );
    }
  });

  it(`body declares Response budget: ~${budget} tokens`, () => {
    const md = readFileSync(filePath, "utf-8");
    const { body } = parseFrontmatter(md);
    const pattern = new RegExp(
      `Response budget:\\s*~?${budget}\\s*tokens`,
      "i",
    );
    expect(
      body,
      `body must declare "Response budget: ~${budget} tokens"`,
    ).toMatch(pattern);
  });

  it("contains none of the forbidden narration phrases", () => {
    const md = readFileSync(filePath, "utf-8");
    for (const phrase of FORBIDDEN_NARRATION) {
      expect(md, `must not contain ${phrase}`).not.toMatch(phrase);
    }
  });

  it("file stays compact (≤60 lines total incl. frontmatter)", () => {
    const md = readFileSync(filePath, "utf-8");
    const lines = md.split(/\r?\n/).length;
    expect(lines, `file must be ≤60 lines (got ${lines})`).toBeLessThanOrEqual(
      60,
    );
  });
});
