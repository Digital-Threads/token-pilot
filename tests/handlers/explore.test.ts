import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { handleExplore } from "../../src/handlers/explore.js";
import { AstIndexClient } from "../../src/ast-index/client.js";
import type { AstIndexExploreResult } from "../../src/ast-index/types.js";

function fakeAstIndex(result: AstIndexExploreResult) {
  return {
    explore: async () => result,
  } as any;
}

describe("handleExplore", () => {
  it("formats ranked symbols, source, blast radius, and tests", async () => {
    // A caller is shown only when its body references a ranked symbol.
    const root = await mkdtemp(join(tmpdir(), "tp-explore-fmt-"));
    await mkdir(join(root, "src", "hooks"), { recursive: true });
    await writeFile(
      join(root, "src", "hooks", "summary-pipeline.ts"),
      "export function runSummaryPipeline() {\n  return new AstIndexClient();\n}\n",
    );
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
          line: 1,
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
      root,
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
      "caller  function runSummaryPipeline  src/hooks/summary-pipeline.ts:1",
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

  // Real `explore SymbolResolver -f 1 --format json` output: for a class,
  // ast-index 3.56 sends the file's outline instead of its source.
  describe("ranked files from both ast-index versions", () => {
    const repoRoot = join(__dirname, "..", "..");
    const fixture = (name: string) =>
      readFileSync(join(repoRoot, "tests", "fixtures", "ast-index", name), "utf-8");
    const run = async (json: string) => {
      const client = new AstIndexClient(repoRoot) as any;
      client.binaryPath = "/bin/ast-index";
      client.ensureIndex = async () => {};
      client.exec = async () => json;

      return (await handleExplore({ query: "SymbolResolver" }, repoRoot, client)).content[0].text;
    };

    it("ast-index 3.50: shows the file's source", async () => {
      const text = await run(fixture("explore-class-3.50.json"));

      expect(text).toContain("src/core/symbol-resolver.ts:5");
      expect(text).toContain("    5\texport class SymbolResolver {");
    });

    it("ast-index 3.56: shows the file's outline when there is no source", async () => {
      const text = await run(fixture("explore-class-3.56.json"));

      expect(text).toContain("src/core/symbol-resolver.ts:5");
      expect(text).toContain("→ :5-100 SymbolResolver [class]");
      expect(text).toContain("  :19-43 resolve [function]");
      expect(text).toContain("  :6 astIndex [property]");
    });

    it("ast-index 3.56: shows 8 outline entries and counts the rest with those the binary left out", async () => {
      const json = JSON.parse(fixture("explore-class-3.56.json"));
      json.files[0].outline_hidden = 3;
      const text = await run(JSON.stringify(json));

      expect(text).toContain("  :92-94 pick [function]");
      expect(text).not.toContain("pathMatches [function]");
      expect(text).toContain("  … 4 more");
    });

    // Real `explore SymbolResolver --format json --rwr` (6 files): 3.56 sends
    // whole function bodies (up to 60 lines), 3.50 mostly a short head.
    it("the 3.56 answer renders no bigger than the 3.50 one", async () => {
      const v350 = await run(fixture("explore-rwr-3.50.json"));
      const v356 = await run(fixture("explore-rwr-3.56.json"));

      expect(v356.length).toBeLessThanOrEqual(v350.length);
    });

    it("cuts a long source and says how many lines were left out", async () => {
      const text = await run(fixture("explore-rwr-3.56.json"));
      const handleReadSymbol = text.split("src/handlers/read-symbol.ts:21\n```\n")[1].split("```")[0];

      expect(handleReadSymbol.split("\n")[0]).toBe("   21\texport async function handleReadSymbol(");
      expect(handleReadSymbol).toContain("   28\t  advisoryReminders = true,\n");
      expect(handleReadSymbol).not.toContain("   29\t");
      expect(handleReadSymbol).toContain("  … 52 more lines\n");
    });
  });
});
