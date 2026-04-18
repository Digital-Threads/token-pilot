/**
 * Phase 4 subtask 4.3 — agent-builder composer test.
 *
 * Composes a final agent .md from three source parts:
 *  - source  (templates/agents/tp-NAME.md — frontmatter + role block only)
 *  - shared  (templates/agents/_shared-preamble.md — plain markdown)
 *  - contract(templates/agents/_response-contract.md — plain markdown)
 *
 * Contract (per TP-816 §5.4.4 + §5.4.9 + advisor notes):
 *  - The source's frontmatter block is preserved byte-for-byte (no YAML
 *    re-serialisation) — we never round-trip through writeFrontmatter.
 *  - Shared preamble appears AFTER frontmatter but BEFORE the role block.
 *  - Response contract appears AFTER the role block.
 *  - Exactly one `---\n...\n---\n` pair in the composed output.
 *  - Composed file ≤60 lines total (tightest: tp-run, 13 tools).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeAgent,
  composeFromFiles,
  composeAll,
} from "../../src/templates/agent-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "agents");

// ─── composeAgent (pure string → string) ─────────────────────────────────────

describe("composeAgent", () => {
  const fakeSource =
    `---\n` +
    `name: tp-fake\n` +
    `description: Fake agent.\n` +
    `tools:\n  - Read\n` +
    `---\n` +
    `Role: fake.\n\nResponse budget: ~100 tokens.\n`;
  const fakeShared = "You are a token-pilot agent (`tp-<name>`). SHARED.\n";
  const fakeContract = "RESPONSE CONTRACT:\n- Verdict first.\n";

  it("preserves the source frontmatter block byte-for-byte", () => {
    const out = composeAgent(fakeSource, fakeShared, fakeContract);
    // Frontmatter must appear exactly once, at the top, with original bytes.
    const fmMatch = out.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    expect(fmMatch).not.toBeNull();
    expect(fakeSource.startsWith(fmMatch![1])).toBe(true);
  });

  it("emits exactly one frontmatter delimiter pair", () => {
    const out = composeAgent(fakeSource, fakeShared, fakeContract);
    const dashes = out.match(/^---$/gm);
    expect(dashes).not.toBeNull();
    expect(dashes!.length).toBe(2);
  });

  it("places shared preamble between frontmatter and role block", () => {
    const out = composeAgent(fakeSource, fakeShared, fakeContract);
    const fmEnd = out.indexOf("---\n", 4) + 4; // end of closing ---
    const sharedIdx = out.indexOf("You are a token-pilot agent");
    const roleIdx = out.indexOf("Role: fake");
    expect(sharedIdx).toBeGreaterThan(fmEnd);
    expect(roleIdx).toBeGreaterThan(sharedIdx);
  });

  it("places response contract after the role block", () => {
    const out = composeAgent(fakeSource, fakeShared, fakeContract);
    const roleIdx = out.indexOf("Response budget: ~100 tokens");
    const contractIdx = out.indexOf("RESPONSE CONTRACT:");
    expect(contractIdx).toBeGreaterThan(roleIdx);
  });

  it("ends with a single trailing newline", () => {
    const out = composeAgent(fakeSource, fakeShared, fakeContract);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n\n")).toBe(false);
  });

  it("trims adjacent blank runs between parts (no triple newlines)", () => {
    const out = composeAgent(fakeSource, fakeShared, fakeContract);
    expect(out).not.toMatch(/\n{4,}/);
  });

  it("throws on source with no frontmatter block", () => {
    expect(() =>
      composeAgent("no frontmatter here\n", fakeShared, fakeContract),
    ).toThrow(/frontmatter/i);
  });
});

// ─── composeFromFiles ─────────────────────────────────────────────────────────

describe("composeFromFiles", () => {
  const sharedPath = join(TEMPLATES_DIR, "_shared-preamble.md");
  const contractPath = join(TEMPLATES_DIR, "_response-contract.md");
  const tpRun = join(TEMPLATES_DIR, "tp-run.md");

  it("reads three files and returns composed string", () => {
    const out = composeFromFiles(tpRun, sharedPath, contractPath);
    expect(out).toContain("name: tp-run");
    expect(out).toContain("You are a token-pilot agent");
    expect(out).toContain("RESPONSE CONTRACT:");
  });
});

// ─── composeAll ──────────────────────────────────────────────────────────────

describe("composeAll", () => {
  it("composes every tp-*.md in templates/agents/", () => {
    const results = composeAll(TEMPLATES_DIR);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual([
      "tp-audit-scanner",
      "tp-commit-writer",
      "tp-dead-code-finder",
      "tp-debugger",
      "tp-history-explorer",
      "tp-impact-analyzer",
      "tp-migration-scout",
      "tp-onboard",
      "tp-pr-reviewer",
      "tp-refactor-planner",
      "tp-run",
      "tp-session-restorer",
      "tp-test-triage",
      "tp-test-writer",
    ]);
  });

  it("excludes _shared-preamble.md and _response-contract.md", () => {
    const results = composeAll(TEMPLATES_DIR);
    for (const { name } of results) {
      expect(name.startsWith("_")).toBe(false);
    }
  });

  it("every composed agent is ≤60 lines (incl. frontmatter)", () => {
    const results = composeAll(TEMPLATES_DIR);
    for (const { name, composed } of results) {
      const lines = composed.split(/\r?\n/).length;
      expect(
        lines,
        `${name} composed file must be ≤60 lines (got ${lines})`,
      ).toBeLessThanOrEqual(60);
    }
  });

  it("every composed agent contains the shared preamble marker", () => {
    const results = composeAll(TEMPLATES_DIR);
    for (const { name, composed } of results) {
      expect(composed, `${name} missing shared preamble`).toContain(
        "You are a token-pilot agent",
      );
    }
  });

  it("every composed agent contains the response contract marker", () => {
    const results = composeAll(TEMPLATES_DIR);
    for (const { name, composed } of results) {
      expect(composed, `${name} missing response contract`).toContain(
        "RESPONSE CONTRACT:",
      );
    }
  });

  it("returns empty array when no tp-*.md files present", () => {
    // Passing a directory with no tp-* files (e.g. parent) returns [].
    const results = composeAll(join(TEMPLATES_DIR, ".."));
    expect(results).toEqual([]);
  });
});
