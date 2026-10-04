/**
 * ast-index indexes node_modules/**\/*.d.ts on every rebuild and update of a
 * project with a package.json (verified on 3.50, .gitignore and
 * .ast-index.yaml `exclude` do not stop it). The client must keep
 * node_modules, dist, coverage and .git out of every result it returns.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AstIndexClient,
  isExcludedPath,
} from "../../src/ast-index/client.js";

function clientWith(handler: (args: string[]) => string): any {
  const client = new AstIndexClient("/repo") as any;
  client.binaryPath = "/bin/ast-index";
  client.ensureIndex = async () => {};
  client.exec = vi.fn(async (args: string[]) => handler(args));
  return client;
}

describe("isExcludedPath", () => {
  it("matches any excluded segment, relative or absolute", () => {
    expect(isExcludedPath("node_modules/hono/dist/index.d.ts")).toBe(true);
    expect(isExcludedPath("packages/a/node_modules/x.d.ts")).toBe(true);
    expect(isExcludedPath("dist/index.js")).toBe(true);
    expect(isExcludedPath("coverage/lcov.info")).toBe(true);
    expect(isExcludedPath(".git/HEAD")).toBe(true);
    expect(isExcludedPath("src/dist-utils.ts")).toBe(false);
    expect(isExcludedPath("src/core/index.ts")).toBe(false);
    expect(isExcludedPath("/repo/node_modules/a.d.ts", "/repo")).toBe(true);
    // A project that itself lives under a "dist" directory is not excluded.
    expect(isExcludedPath("/home/u/dist/proj/src/a.ts", "/home/u/dist/proj")).toBe(false);
  });

  it("dist and coverage are build output only at the project root; a source dir of that name stays", () => {
    expect(isExcludedPath("internal/coverage/cover.go")).toBe(false);
    expect(isExcludedPath("pkg/dist/plan.ts")).toBe(false);
    expect(isExcludedPath("/repo/internal/coverage/cover.go", "/repo")).toBe(false);
    expect(isExcludedPath("./dist/index.js")).toBe(true);
    expect(isExcludedPath("/repo/coverage/lcov.info", "/repo")).toBe(true);
    expect(isExcludedPath("packages/a/node_modules/x.d.ts")).toBe(true);
    expect(isExcludedPath("vendor/x/.git/HEAD")).toBe(true);
  });

  it("listFiles keeps a nested coverage/ or dist/ directory in the index query", async () => {
    const client = clientWith(() => JSON.stringify({ rows: [{ path: "internal/coverage/cover.go" }] }));

    expect(await client.listFiles()).toEqual(["internal/coverage/cover.go"]);
    const sql: string = client.exec.mock.calls[0][0][1];
    expect(sql).toContain("'%/node_modules/%'");
    expect(sql).not.toContain("'%/coverage/%'");
    expect(sql).not.toContain("'%/dist/%'");
    expect(sql).toContain("'coverage/%'");
  });
});

describe("AstIndexClient drops excluded directories from results", () => {
  it("refs: definitions, imports and usages", async () => {
    const client = clientWith(() =>
      JSON.stringify({
        definitions: [
          { name: "find", path: "node_modules/typescript/lib/lib.es5.d.ts", line: 1 },
          { name: "find", path: "src/a.ts", line: 3 },
        ],
        imports: [{ name: "find", path: "dist/a.js", line: 1 }],
        usages: [
          { name: "find", path: "coverage/x.js", line: 9 },
          { name: "find", path: "src/b.ts", line: 4 },
        ],
      }),
    );
    const refs = await client.refs("find");
    expect(refs.definitions.map((d: any) => d.path)).toEqual(["src/a.ts"]);
    expect(refs.imports).toEqual([]);
    expect(refs.usages.map((u: any) => u.path)).toEqual(["src/b.ts"]);
  });

  it("refs and search flag a section that reached the requested limit", async () => {
    const two = [
      { name: "f", path: "src/a.ts", line: 1, content: "f()" },
      { name: "f", path: "node_modules/b.d.ts", line: 2, content: "f()" },
    ];
    const client = clientWith((args) =>
      args[0] === "refs"
        ? JSON.stringify({ definitions: [], imports: [], usages: two })
        : JSON.stringify({ content_matches: two, symbols: [] }),
    );

    expect((await client.refs("f", 2)).truncated).toBe(true);
    expect((await client.refs("f", 3)).truncated).toBeUndefined();
    expect((await client.search("f", { maxResults: 2 })).truncated).toBe(true);
    expect((await client.search("f", { maxResults: 3 })).truncated).toBeUndefined();
    expect(client.exec.mock.calls[2][0]).toEqual(expect.arrayContaining(["--limit", "2"]));
  });

  it("search and usages", async () => {
    const client = clientWith((args) =>
      args[0] === "search"
        ? JSON.stringify({
            content_matches: [
              { path: "node_modules/x/index.d.ts", line: 1, content: "foo()" },
              { path: "src/a.ts", line: 2, content: "foo()" },
            ],
          })
        : JSON.stringify([
            { path: "node_modules/x/index.d.ts", line: 1, context: "foo" },
            { path: "src/a.ts", line: 5, context: "foo" },
          ]),
    );
    expect((await client.search("foo")).map((r: any) => r.file)).toEqual(["src/a.ts"]);
    expect((await client.usages("foo")).map((r: any) => r.file)).toEqual(["src/a.ts"]);
  });

  it("symbol picks the first definition outside excluded dirs", async () => {
    const client = clientWith(() =>
      JSON.stringify([
        { name: "Foo", kind: "class", path: "node_modules/x/index.d.ts", line: 1 },
        { name: "Foo", kind: "class", path: "src/foo.ts", line: 7 },
      ]),
    );
    expect((await client.symbol("Foo"))?.file).toBe("src/foo.ts");
  });

  it("implementations (json carries `path`)", async () => {
    const client = clientWith(() =>
      JSON.stringify([
        { name: "$ZodError", kind: "class", path: "node_modules/zod/core.d.ts", line: 1 },
        { name: "MyError", kind: "class", path: "src/errors.ts", line: 3 },
      ]),
    );
    expect((await client.implementations("Error")).map((i: any) => i.name)).toEqual(["MyError"]);
  });

  it("callTree parses the text output (json is ignored by the binary) and drops vendored callers", async () => {
    const client = clientWith(() =>
      [
        "Call tree for 'fetchUser':",
        "  fetchUser",
        "    ← getProfile (src/profile.ts:10)",
        "    ← wrap (node_modules/lib/index.d.ts:3)",
        "",
      ].join("\n"),
    );
    const tree = await client.callTree("fetchUser", 2);
    expect(tree?.callers?.map((c: any) => c.name)).toEqual(["getProfile"]);
    const args: string[] = client.exec.mock.calls[0][0];
    expect(args).not.toContain("json");
    expect(args).toEqual(expect.arrayContaining(["--depth", "2", "--limit"]));
    expect(tree?.capped).toBeUndefined();
  });

  it("callTree drops callers whose location is not a symbol definition (grep artefacts)", async () => {
    const client = clientWith((args) =>
      args[0] === "query"
        ? JSON.stringify({
            rows: [
              { path: "src/profile.ts", line: 10, name: "getProfile" },
              { path: "src/router.ts", line: 7, name: "route" },
            ],
          })
        : [
            "Call tree for 'fetchUser':",
            "  fetchUser",
            "    ← getProfile (src/profile.ts:10)",
            "      ← route (src/router.ts:7)",
            "    ← Set (src/profile.ts:168)",
            "      ← import (src/index.ts:1738)",
            "    ← route (recursive)",
            "    ← Set (recursive)",
          ].join("\n"),
    );
    const tree = await client.callTree("fetchUser", 2);
    // "route (recursive)" still points at a shown node; "Set (recursive)" does not.
    expect(tree?.callers?.map((c: any) => c.name)).toEqual(["getProfile", "route"]);
    expect(tree?.callers?.[0].callers?.map((c: any) => c.name)).toEqual(["route"]);
    expect(tree?.dropped).toBe(1);
  });

  it("callTree keeps a caller only when its body references the callee outside comments", async () => {
    const root = mkdtempSync(join(tmpdir(), "tp-calltree-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "parser.ts"), [
        "export function parseFileCount(text: string): number {",
        "  return Number(text);",
        "}",
        "",
        "/**",
        " * buildFileStructure() rebuilds nesting from these entries.",
        " */",
        "export function parseOutlineText(text: string): string[] {",
        "  return text.split(\"\\n\");",
        "}",
        "",
        "export function onlyComment(): number {",
        "  // buildFileStructure runs later",
        "  return 1;",
        "}",
        "",
        "export function realCaller(): unknown {",
        "  return buildFileStructure(\"x\");",
        "}",
        "",
      ].join("\n"));
      const client = new AstIndexClient(root) as any;
      client.binaryPath = "/bin/ast-index";
      client.ensureIndex = async () => {};
      client.exec = vi.fn(async (args: string[]) =>
        args[0] === "query"
          ? JSON.stringify({
              rows: [
                { path: "src/parser.ts", line: 1, name: "parseFileCount" },
                { path: "src/parser.ts", line: 12, name: "onlyComment" },
                { path: "src/parser.ts", line: 17, name: "realCaller" },
                { path: "src/client.ts", line: 5, name: "buildIndex" },
              ],
            })
          : [
              "Call tree for 'buildFileStructure':",
              "  buildFileStructure",
              "    ← parseFileCount (src/parser.ts:1)",
              "      ← buildIndex (src/client.ts:5)",
              "    ← onlyComment (src/parser.ts:12)",
              "    ← realCaller (src/parser.ts:17)",
            ].join("\n"),
      );

      const tree = await client.callTree("buildFileStructure", 2);

      expect(tree?.callers?.map((c: any) => c.name)).toEqual(["realCaller"]);
      expect(tree?.dropped).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("callTree marks a level that hit the per-level cap before vendored callers are dropped", async () => {
    const client = clientWith(() =>
      [
        "Call tree for 'f':",
        "  f",
        "    ← a (src/a.ts:1)",
        "    ← b (node_modules/b.d.ts:1)",
        "    ← c (src/c.ts:1)",
      ].join("\n"),
    );
    const tree = await client.callTree("f", 1, 1);
    expect(client.exec.mock.calls[0][0]).toEqual(expect.arrayContaining(["--limit", "3"]));
    expect(tree?.capped).toBe(true);
    expect(tree?.callers?.map((c: any) => c.name)).toEqual(["a"]);
  });

  it("unusedSymbols", async () => {
    const client = clientWith(() =>
      JSON.stringify([
        { name: "a", kind: "function", path: "node_modules/x/index.d.ts", line: 1 },
        { name: "b", kind: "function", path: "src/b.ts", line: 2 },
      ]),
    );
    expect((await client.unusedSymbols()).map((s: any) => s.name)).toEqual(["b"]);
    // The binary's cap applies before vendored entries are dropped.
    expect((await client.unusedSymbols({ limit: 2 })).truncated).toBe(true);
    expect((await client.unusedSymbols({ limit: 3 })).truncated).toBeUndefined();
  });

  it("explore drops vendored symbols, files, neighbours and tests", async () => {
    const client = clientWith(() =>
      JSON.stringify({
        query: "q",
        symbols: [
          { name: "a", kind: "function", path: "node_modules/a.d.ts", line: 1, score: 1 },
          { name: "b", kind: "function", path: "src/b.ts", line: 1, score: 1 },
        ],
        files: [{ path: "dist/b.js", line: 1, source: "" }],
        neighbours: [{ name: "c", kind: "function", path: "node_modules/c.d.ts", line: 1, link: "caller" }],
        tests: [{ source: "src/b.ts", tests: ["tests/b.test.ts", "node_modules/x/test.js"] }],
      }),
    );
    const res = await client.explore("q");
    expect(res.symbols.map((s: any) => s.name)).toEqual(["b"]);
    expect(res.files).toEqual([]);
    expect(res.neighbours).toEqual([]);
    expect(res.tests).toEqual([{ source: "src/b.ts", tests: ["tests/b.test.ts"] }]);
  });

  it("listFiles reads the index through `query` (there is no `files` command)", async () => {
    const client = clientWith((args) => {
      if (args[0] !== "query") throw new Error(`unexpected ${args[0]}`);
      return JSON.stringify({
        columns: ["path"],
        rows: [{ path: "src/a.ts" }, { path: "node_modules/x/index.d.ts" }, { path: "tests/a.test.ts" }],
      });
    });
    expect(await client.listFiles()).toEqual(["src/a.ts", "tests/a.test.ts"]);
    const sql: string = client.exec.mock.calls[0][0][1];
    expect(sql).toContain("node_modules");
  });

  it("conventions drops frameworks and naming patterns drawn from vendored declarations", async () => {
    const conv = {
      architecture: ["Hooks pattern"],
      frameworks: { Async: [{ name: "Rx", count: 13 }] },
      naming_patterns: [{ suffix: "Module", count: 25 }],
    };
    const polluted = clientWith((args) =>
      args[0] === "query"
        ? JSON.stringify({ rows: [{ n: 1120 }] })
        : JSON.stringify(conv),
    );
    expect(await polluted.conventions()).toEqual({
      architecture: ["Hooks pattern"],
      frameworks: {},
      naming_patterns: [],
      vendored_skipped: true,
    });

    const clean = clientWith((args) =>
      args[0] === "query"
        ? JSON.stringify({ rows: [{ n: 0 }] })
        : JSON.stringify(conv),
    );
    expect(await clean.conventions()).toEqual(conv);
  });

  it("map drops excluded groups, counts only project files and keeps the limit", async () => {
    const client = clientWith((args) => {
      if (args[0] === "query") {
        return JSON.stringify({ columns: ["n"], rows: [{ n: 293 }] });
      }
      return JSON.stringify({
        project_type: "ts",
        file_count: 1413,
        module_count: 0,
        showing: 4,
        total_dirs: 4,
        groups: [
          { path: "node_modules/hono/", file_count: 189 },
          { path: "src/handlers/", file_count: 30 },
          { path: "node_modules/zod/", file_count: 50 },
          { path: "src/core/", file_count: 20 },
        ],
      });
    });
    const map = await client.map({ limit: 1 });
    expect(map.groups.map((g: any) => g.path)).toEqual(["src/handlers/"]);
    expect(map.showing).toBe(1);
    expect(map.total_dirs).toBe(2);
    expect(map.file_count).toBe(293);
  });
});
