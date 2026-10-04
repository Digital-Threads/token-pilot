/**
 * Parsers for ast-index commands that print text only (they ignore
 * `--format json`). Every fixture under tests/fixtures/ast-index/ is real
 * output of ast-index 3.50.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCallTreeText,
  parseImportsText,
  parseJsImports,
} from "../../src/ast-index/parser.js";

describe("parseImportsText", () => {
  it("keeps type-only, mixed, side-effect and require imports", () => {
    expect(parseImportsText(fixture("imports-ts.txt"))).toEqual([
      { specifiers: ["Foo", "Bar"], source: "./types.js" },
      { specifiers: ["Baz", "qux"], source: "./other.js" },
      { specifiers: ["def", "named"], source: "./mixed.js", isDefault: true },
      { specifiers: ["ns"], source: "pkg", isNamespace: true },
      { specifiers: ["Thing"], source: "./thing.js", isDefault: true },
      { specifiers: [], source: "./side-effect.js" },
    ]);
    expect(parseImportsText(fixture("imports-require.txt"))).toEqual([
      { specifiers: ["x"], source: "./y", isDefault: true },
    ]);
  });

  it("reads Python and Java module imports", () => {
    expect(parseImportsText(fixture("imports-py.txt"))).toEqual([
      { specifiers: ["User", "Group"], source: "pkg.models" },
      { specifiers: ["os.path"], source: "os.path", isNamespace: true },
      { specifiers: ["json"], source: "json", isNamespace: true },
    ]);
    expect(parseImportsText(fixture("imports-java.txt"))).toEqual([
      { specifiers: ["Service"], source: "org.springframework.stereotype.Service" },
    ]);
  });

  it("skips the first-line stubs the binary prints for multi-line imports", () => {
    const entries = parseImportsText(fixture("imports-multiline.txt"));
    expect(entries.every((e) => e.source.length > 0)).toBe(true);
    expect(entries.map((e) => e.source)).toContain("../types.js");
  });
});

describe("parseJsImports", () => {
  it("finds every module specifier, multi-line lists included", () => {
    const src = [
      "import {",
      "  a,",
      "  type B,",
      "  c as d,",
      "} from './multi.js';",
      "import type { T } from '../types.js'",
      "import def, { x } from \"./mixed\"",
      "import * as ns from 'pkg';",
      "import './side.css';",
      "export { r } from './re.js';",
      "export * from './star.js';",
      "const lazy = await import('./lazy.js');",
      "const cjs = require(\"./cjs.cjs\");",
      "const notAnImport = 'from ./nowhere';",
    ].join("\n");

    expect(parseJsImports(src)).toEqual([
      { specifiers: ["a", "B", "c"], source: "./multi.js" },
      { specifiers: ["T"], source: "../types.js" },
      { specifiers: ["def", "x"], source: "./mixed" },
      { specifiers: ["ns"], source: "pkg" },
      { specifiers: ["r"], source: "./re.js" },
      { specifiers: ["*"], source: "./star.js" },
      { specifiers: [], source: "./side.css" },
      { specifiers: [], source: "./lazy.js" },
      { specifiers: [], source: "./cjs.cjs" },
    ]);
  });
});

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
