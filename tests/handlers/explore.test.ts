import { describe, it, expect } from "vitest";
import { handleExplore } from "../../src/handlers/explore.js";
import type { AstIndexExploreResult } from "../../src/ast-index/types.js";

function fakeAstIndex(result: AstIndexExploreResult) {
  return {
    explore: async () => result,
  } as any;
}

describe("handleExplore", () => {
  it("formats ranked symbols, source, blast radius, and tests", async () => {
    const result: AstIndexExploreResult = {
      query: "AstIndexClient buildIndex",
      dominantLanguage: "ts",
      symbols: [
        {
          name: "AstIndexClient",
          kind: "class",
          path: "src/ast-index/client.ts",
          line: 54,
          score: 1000,
          vendor: false,
        },
      ],
      files: [
        {
          path: "src/ast-index/client.ts",
          line: 54,
          source: "   54\texport class AstIndexClient {\n   55\t  ...\n",
        },
      ],
      neighbours: [
        {
          name: "runSummaryPipeline",
          kind: "function",
          path: "src/hooks/summary-pipeline.ts",
          line: 69,
          link: "caller",
        },
      ],
      tests: [
        {
          source: "src/ast-index/client.ts",
          tests: ["tests/ast-index/client.test.ts"],
        },
      ],
    };

    const out = await handleExplore(
      { query: "AstIndexClient buildIndex" },
      "/repo",
      fakeAstIndex(result),
    );
    const text = out.content[0].text;

    // Query in header
    expect(text).toContain('# explore: "AstIndexClient buildIndex"');
    expect(text).toContain("(lang: ts)");

    // Ranked symbol
    expect(text).toContain("## Ranked symbols");
    expect(text).toContain("1000  class AstIndexClient  src/ast-index/client.ts:54");

    // Source block
    expect(text).toContain("## Source");
    expect(text).toContain("export class AstIndexClient {");

    // Blast-radius / graph neighbour line
    expect(text).toContain("## Graph neighbours (blast radius)");
    expect(text).toContain(
      "caller  function runSummaryPipeline  src/hooks/summary-pipeline.ts:69",
    );

    // Test path grouped by source
    expect(text).toContain("## Tests");
    expect(text).toContain("tests/ast-index/client.test.ts");

    expect(out.meta).toEqual({
      query: "AstIndexClient buildIndex",
      symbolCount: 1,
      fileCount: 1,
      neighbourCount: 1,
      testCount: 1,
    });
  });

  it("marks vendor symbols and returns a no-results message when empty", async () => {
    const vendorResult: AstIndexExploreResult = {
      query: "lodash",
      dominantLanguage: "ts",
      symbols: [
        {
          name: "merge",
          kind: "function",
          path: "node_modules/lodash/merge.js",
          line: 1,
          score: 500,
          vendor: true,
        },
      ],
      files: [],
      neighbours: [],
      tests: [],
    };
    const vendorOut = await handleExplore(
      { query: "lodash" },
      "/repo",
      fakeAstIndex(vendorResult),
    );
    expect(vendorOut.content[0].text).toContain("[vendor]");

    const empty: AstIndexExploreResult = {
      query: "nothingmatches",
      dominantLanguage: "",
      symbols: [],
      files: [],
      neighbours: [],
      tests: [],
    };
    const emptyOut = await handleExplore(
      { query: "nothingmatches" },
      "/repo",
      fakeAstIndex(empty),
    );
    expect(emptyOut.content[0].text).toContain("No results");
    expect(emptyOut.meta.symbolCount).toBe(0);
  });
});
