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

  it("description is task-focused, ≤350 chars, no <example> blocks", () => {
    const md = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(md);
    const desc = String(meta.description ?? "");

    expect(desc.length).toBeGreaterThan(0);
    // v0.23.3: increased from 160 → 350 to accommodate PROACTIVELY trigger
    // phrases + concrete user-intent signals ("when the user reports …").
    // Under 160 was too tight for Claude Code to reliably auto-invoke.
    expect(
      desc.length,
      `description must be ≤350 chars (got ${desc.length})`,
    ).toBeLessThanOrEqual(350);
    expect(desc, "description must not contain <example> blocks").not.toMatch(
      /<example>/i,
    );
  });

  it("has an explicit invocation trigger (PROACTIVELY or 'Use this when')", () => {
    const md = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(md);
    const desc = String(meta.description ?? "");

    // v0.23.3: every tp-* needs a concrete trigger phrase so Claude Code
    // can auto-invoke. Either "PROACTIVELY" (Anthropic's canonical keyword)
    // or an explicit "Use this when …" sentence. Descriptions without a
    // trigger used to sit unused even when they fit the task.
    const hasTrigger =
      /PROACTIVELY/.test(desc) || /\bUse this when\b/i.test(desc);
    expect(
      hasTrigger,
      `${name} description needs a trigger phrase ('PROACTIVELY …' or 'Use this when …')`,
    ).toBe(true);
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

  it("role block (body) is ≤30 non-empty lines per TP-816 §5.4.4", () => {
    const md = readFileSync(filePath, "utf-8");
    const { body } = parseFrontmatter(md);
    const bodyLines = body.split(/\r?\n/).filter((l) => l.trim() !== "").length;
    expect(
      bodyLines,
      `role block must be ≤30 non-empty lines (got ${bodyLines})`,
    ).toBeLessThanOrEqual(30);
  });

  it("description reads as multiple sentences (trigger + scope + boundary)", () => {
    const md = readFileSync(filePath, "utf-8");
    const { meta } = parseFrontmatter(md);
    const desc = String(meta.description ?? "");
    const sentences = desc.split(/\.\s+/).filter(Boolean);
    expect(
      sentences.length,
      `description should read as multiple sentences (got "${desc}")`,
    ).toBeGreaterThanOrEqual(2);
  });
});
