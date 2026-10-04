/**
 * Parsers for ast-index commands that print text only (they ignore
 * `--format json`). Every fixture under tests/fixtures/ast-index/ is real
 * output of ast-index 3.50.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCallTreeText } from "../../src/ast-index/parser.js";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "../fixtures/ast-index", name), "utf-8");

describe("parseCallTreeText", () => {
  it("builds the caller tree from the indented ← lines", () => {
    const tree = parseCallTreeText(fixture("call-tree.txt"));

    expect(tree?.name).toBe("estimateTokens");
    expect(tree?.callers?.map((c) => c.name)).toEqual([
      "benchmarkFile",
      "next",
      "finalResponseTokens",
      "ContextRegistry",
    ]);
    expect(tree?.callers?.[0]).toEqual({
      name: "benchmarkFile",
      file: "scripts/benchmark.ts",
      line: 72,
      callers: [
        { name: "benchmarkRepo", file: "scripts/benchmark.ts", line: 104, callers: [] },
      ],
    });

    const final = tree?.callers?.[2];
    expect(final?.callers?.map((c) => c.name)).toEqual([
      "writeFile",
      "writeFile",
      "transcript",
      "checkSubagentBudget",
    ]);
    expect(final?.callers?.[1]).toEqual({ name: "writeFile", recursive: true, callers: [] });
  });

  it("returns a bare root when nothing calls the function", () => {
    expect(parseCallTreeText(fixture("call-tree-empty.txt"))).toEqual({
      name: "noSuchFunctionXyz",
      callers: [],
    });
  });

  it("returns null for empty output", () => {
    expect(parseCallTreeText("")).toBeNull();
  });
});
