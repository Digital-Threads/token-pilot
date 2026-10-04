/**
 * Parsers for ast-index commands that print text only (they ignore
 * `--format json`). Every fixture under tests/fixtures/ast-index/ is real
 * output of ast-index 3.50.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAgrepText,
  parseAnnotationsText,
  parseCallTreeText,
  parseDeprecatedText,
  parseImportsText,
  parseJsImports,
  parseTodoText,
} from "../../src/ast-index/parser.js";

describe("code-audit parsers (grouped blocks)", () => {
  it("parseTodoText reads `KIND (n):` groups of path:line + comment", () => {
    const entries = parseTodoText(fixture("todo.txt"));

    expect(entries).toHaveLength(4);
    expect(entries).toContainEqual({
      file: "web/a.ts",
      line: 9,
      kind: "TODO",
      text: "(alice): handle errors",
    });
    expect(entries).toContainEqual({
      file: "src/main/java/com/x/Svc.java",
      line: 15,
      kind: "FIXME",
      text: "broken when null",
    });
    expect(entries).toContainEqual({
      file: "src/main/java/com/x/Other.java",
      line: 6,
      kind: "HACK",
      text: "temporary workaround",
    });
    expect(parseTodoText(fixture("todo-empty.txt"))).toEqual([]);
  });

  it("parseDeprecatedText reads path:line + the marker line", () => {
    expect(parseDeprecatedText(fixture("deprecated.txt"))).toEqual([
      { kind: "", name: "", file: "web/a.ts", line: 10, message: "use newThing" },
      { kind: "", name: "", file: "src/main/java/com/x/Svc.java", line: 8, message: undefined },
      { kind: "", name: "", file: "src/main/java/com/x/Svc.java", line: 11, message: "use newer" },
      { kind: "", name: "", file: "src/main/java/com/x/Svc.java", line: 12, message: undefined },
    ]);
  });

  it("parseAnnotationsText reads path:line entries", () => {
    expect(parseAnnotationsText(fixture("annotations.txt"), "Service")).toEqual([
      { kind: "", name: "", file: "src/main/java/com/x/Svc.java", line: 5, annotation: "Service" },
      { kind: "", name: "", file: "src/main/java/com/x/Other.java", line: 3, annotation: "Service" },
    ]);
    expect(parseAnnotationsText(fixture("annotations-empty.txt"), "Nope")).toEqual([]);
  });

  it("parseAgrepText reads ast-grep json: one entry per match, 1-based lines", () => {
    expect(parseAgrepText(fixture("agrep.json"))).toEqual([
      { file: "web/b.ts", line: 2, text: "console.log(a);" },
      { file: "web/b.ts", line: 6, text: "console.log( … (3 lines)" },
    ]);
  });
});

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
