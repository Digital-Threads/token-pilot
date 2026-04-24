import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBinary = vi.hoisted(() => ({
  findBinary: vi.fn(),
  installBinary: vi.fn(),
}));

vi.mock("../../src/ast-index/binary-manager.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/ast-index/binary-manager.js")
  >("../../src/ast-index/binary-manager.js");
  return {
    ...actual,
    findBinary: mockBinary.findBinary,
    installBinary: mockBinary.installBinary,
  };
});

import { AstIndexClient } from "../../src/ast-index/client.js";
import {
  parseFileCount,
  parseImplementationsText,
  parseHierarchyText,
  parseImportsText,
  parseAgrepText,
  parseTodoText,
  parseDeprecatedText,
  parseAnnotationsText,
  parseModuleListText,
  parseModuleDepText,
  parseUnusedDepsText,
  parseModuleApiText,
  parseOutlineText,
  mapKind,
  mapVisibility,
  detectLanguage,
} from "../../src/ast-index/parser.js";
import {
  buildFileStructure,
  fixLastEndLine,
} from "../../src/ast-index/enricher.js";

describe("AstIndexClient", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "token-pilot-ast-client-"));
    mockBinary.findBinary.mockReset();
    mockBinary.installBinary.mockReset();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("initializes from an existing binary or auto-installs one", async () => {
    mockBinary.findBinary.mockResolvedValueOnce({
      available: true,
      path: "/bin/ast-index",
      version: "1.0.0",
      source: "PATH",
    });
    const existing = new AstIndexClient(tempDir);
    await existing.init();
    expect(existing.isAvailable()).toBe(true);

    mockBinary.findBinary.mockResolvedValueOnce({
      available: false,
      path: null,
      version: null,
      source: null,
    });
    mockBinary.installBinary.mockResolvedValueOnce({
      path: "/installed/ast-index",
      version: "1.1.0",
    });
    const install = new AstIndexClient(tempDir);
    await install.init();
    expect(install.isAvailable()).toBe(true);
  });

  it("throws when init cannot find or install the binary", async () => {
    mockBinary.findBinary.mockResolvedValue({
      available: false,
      path: null,
      version: null,
      source: null,
    });
    mockBinary.installBinary.mockRejectedValue(new Error("download failed"));

    const client = new AstIndexClient(tempDir);
    await expect(client.init()).rejects.toThrow("ast-index binary not found");
  });

  it("handles index state guards and deduplicates concurrent ensureIndex calls", async () => {
    const client = new AstIndexClient(tempDir) as any;

    client.disableIndex();
    await expect(client.ensureIndex()).rejects.toThrow("index build disabled");
    client.enableIndex();
    client.indexOversized = true;
    await expect(client.ensureIndex()).rejects.toThrow(
      "previous build indexed >50k files",
    );

    client.indexOversized = false;
    const buildIndex = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      client.indexed = true;
    });
    client.buildIndex = buildIndex;

    await Promise.all([client.ensureIndex(), client.ensureIndex()]);
    expect(buildIndex).toHaveBeenCalledTimes(1);

    client.updateProjectRoot("/new-root");
    expect(client.isDisabled()).toBe(false);
    expect(client.isOversized()).toBe(false);
    await expect(client.exec(["stats"])).rejects.toThrow(
      "ast-index not initialized",
    );
  });

  it("parses file counts and parser helpers correctly", () => {
    expect(parseFileCount('{"stats":{"file_count":42}}')).toBe(42);
    expect(parseFileCount("Files: 17")).toBe(17);
    expect(parseFileCount("nope")).toBe(0);

    expect(parseImplementationsText("class MyImpl (/repo/a.php:42)")).toEqual([
      { kind: "class", name: "MyImpl", file: "/repo/a.php", line: 42 },
    ]);

    expect(
      parseHierarchyText(
        `Hierarchy for 'Base':\nParents:\n  Parent (extends)\nChildren:\n  Child (implements)  (/repo/child.ts:7)`,
        "Base",
      ),
    ).toEqual({
      name: "Base",
      kind: "class",
      parents: [
        {
          name: "Parent",
          kind: "extends",
          children: [],
          file: undefined,
          line: undefined,
        },
      ],
      children: [
        {
          name: "Child",
          kind: "implements",
          children: [],
          file: "/repo/child.ts",
          line: 7,
        },
      ],
    });

    expect(
      parseImportsText(
        `Imports in /repo/a.ts:\n{ foo, bar } from "./b"\n* as ns from "pkg"\nThing from "./thing"\nTotal: 3`,
      ),
    ).toEqual([
      { specifiers: ["foo", "bar"], source: "./b" },
      { specifiers: ["ns"], source: "pkg", isNamespace: true },
      { specifiers: ["Thing"], source: "./thing", isDefault: true },
    ]);

    expect(parseAgrepText("/repo/a.ts:10: matched text")).toEqual([
      { file: "/repo/a.ts", line: 10, text: "matched text" },
    ]);
    expect(parseTodoText("/repo/a.ts:5: TODO: fix this")).toEqual([
      { file: "/repo/a.ts", line: 5, kind: "TODO", text: "fix this" },
    ]);
    expect(
      parseDeprecatedText("function oldFn (/repo/a.ts:8) - use newFn"),
    ).toEqual([
      {
        kind: "function",
        name: "oldFn",
        file: "/repo/a.ts",
        line: 8,
        message: "use newFn",
      },
    ]);
    expect(
      parseAnnotationsText(
        "@Injectable class UserService (/repo/a.ts:2)",
        "Injectable",
      ),
    ).toEqual([
      {
        kind: "class",
        name: "UserService",
        file: "/repo/a.ts",
        line: 2,
        annotation: "Injectable",
      },
    ]);
    expect(parseModuleListText("auth (src/auth) — 3 files")).toEqual([
      { name: "auth", path: "src/auth", file_count: 3 },
    ]);
    expect(parseModuleDepText("→ db (src/db) [direct]")).toEqual([
      { name: "db", path: "src/db", type: "direct" },
    ]);
    expect(parseUnusedDepsText("⚠ legacy (src/legacy) — unused")).toEqual([
      { name: "legacy", path: "src/legacy", reason: "unused" },
    ]);
    expect(
      parseModuleApiText("function login login() (/repo/src/auth.ts:12)"),
    ).toEqual([
      {
        kind: "function",
        name: "login",
        signature: "login()",
        file: "/repo/src/auth.ts",
        line: 12,
      },
    ]);

    expect(mapKind("trait")).toBe("interface");
    expect(mapVisibility("pub")).toBe("public");
    expect(detectLanguage("thing.py")).toBe("Python");
    expect(detectLanguage("thing.unknown")).toBe("Unknown");
  });

  it("parses outline text and builds enriched file structures for python and php", async () => {
    const outlineEntries = parseOutlineText(
      [
        "Outline of src/file.ts:",
        "  :1 MyClass [class]",
        "    :3 methodA [function]",
        "  :8 freeFn [function]",
      ].join("\n"),
    );

    expect(outlineEntries[0].children?.[0].name).toBe("methodA");
    expect(outlineEntries[0].end_line).toBe(7);
    expect(outlineEntries[1].end_line).toBe(18);

    const pyFile = join(tempDir, "sample.py");
    await writeFile(
      pyFile,
      [
        "class MyClass:",
        "    @staticmethod",
        "    def build():",
        "        return 1",
        "    async def run(self):",
        "        return 2",
      ].join("\n"),
    );
    const pyStructure = await buildFileStructure(pyFile, [
      { name: "MyClass", kind: "class", start_line: 1, end_line: 6 },
    ]);
    expect(pyStructure.language).toBe("Python");
    expect(pyStructure.symbols[0].children.length).toBe(1);
    expect(pyStructure.symbols[0].children[0].static).toBe(true);

    const phpFile = join(tempDir, "sample.php");
    await writeFile(
      phpFile,
      [
        "<?php",
        "class MyPhp {",
        "    public function run() {",
        "        return 1;",
        "    }",
        "    private static function build() {",
        "        return 2;",
        "    }",
        "}",
      ].join("\n"),
    );
    const phpStructure = await buildFileStructure(phpFile, [
      { name: "MyPhp", kind: "class", start_line: 2, end_line: 9 },
    ]);
    expect(phpStructure.language).toBe("PHP");
    expect(phpStructure.symbols[0].children.length).toBe(2);
    expect(phpStructure.symbols[0].children[1].static).toBe(true);
  });

  it("backtracks python method end lines around decorators and fixes nested last-entry ranges", async () => {
    const pyFile = join(tempDir, "decorated.py");
    await writeFile(
      pyFile,
      [
        "class Demo:",
        "    def first(self):",
        "        return 1",
        "",
        "    @staticmethod",
        "    def second():",
        "        return 2",
        "    def _protected(self):",
        "        return 3",
        "    def __private(self):",
        "        return 4",
      ].join("\n"),
    );

    const pyStructure = await buildFileStructure(pyFile, [
      { name: "Demo", kind: "class", start_line: 1, end_line: 11 },
    ]);
    expect(pyStructure.symbols[0].children[0].location.endLine).toBe(3);
    expect(pyStructure.symbols[0].children[1].location.endLine).toBe(7);
    expect(pyStructure.symbols[0].children[2].visibility).toBe("protected");
    expect(pyStructure.symbols[0].children[3].visibility).toBe("private");

    const nested = [
      {
        name: "Outer",
        kind: "class",
        start_line: 1,
        end_line: 1,
        children: [
          { name: "inner", kind: "method", start_line: 2, end_line: 0 },
        ],
      },
    ];
    fixLastEndLine(nested, 20);
    expect(nested[0].end_line).toBe(20);
    expect(nested[0].children[0].end_line).toBe(19);
  });

  it("supports common public methods through a mocked exec layer", async () => {
    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = "/bin/ast-index";
    client.ensureIndex = async () => {};
    client.astGrepAvailable = true;

    const targetFile = join(tempDir, "file.ts");
    const targetContent = "export class Demo {}\n";
    await writeFile(targetFile, targetContent);

    client.exec = vi.fn(async (args: string[]) => {
      switch (args[0]) {
        case "outline":
          return "  :1 Demo [class]\n";
        case "symbol":
          return JSON.stringify([
            {
              name: "Demo",
              kind: "class",
              path: "/repo/file.ts",
              line: 1,
              signature: "class Demo",
            },
          ]);
        case "search":
          return JSON.stringify({
            content_matches: [
              { path: "/repo/a.ts", line: 3, content: "Demo()" },
            ],
            symbols: [
              { path: "/repo/a.ts", line: 4, signature: "function Demo" },
            ],
            files: [{ path: "/repo/file.ts", line: 1 }],
            references: [{ path: "/repo/a.ts", line: 3, text: "Demo()" }],
          });
        case "usages":
          return JSON.stringify([
            { path: "/repo/a.ts", line: 8, context: "Demo()" },
          ]);
        case "implementations":
          return "class DemoImpl (/repo/a.ts:9)";
        case "hierarchy":
          return "Hierarchy for 'Demo':\nParents:\n  Base (extends)\n";
        case "stats":
          return "Files: 5\nSymbols: 9";
        case "files":
          return "/repo/a.ts\n/repo/b.ts\n";
        case "refs":
          return JSON.stringify({
            definitions: [{ path: "/repo/a.ts", line: 1 }],
            imports: [],
            usages: [],
          });
        case "map":
          return JSON.stringify({
            project_type: "ts",
            file_count: 2,
            groups: [],
          });
        case "conventions":
          return JSON.stringify({
            architecture: ["layered"],
            frameworks: {},
            naming_patterns: [],
          });
        case "callers":
          return JSON.stringify([
            { name: "caller", path: "/repo/a.ts", line: 3 },
          ]);
        case "call-tree":
          return JSON.stringify({ name: "root", children: [] });
        case "changed":
          return JSON.stringify([
            { name: "Demo", kind: "class", file: "/repo/a.ts", line: 1 },
          ]);
        case "unused-symbols":
          return JSON.stringify([
            { name: "Dead", kind: "function", path: "/repo/a.ts", line: 2 },
          ]);
        case "imports":
          return '{ Demo } from "./demo"';
        case "agrep":
          return "/repo/a.ts:4: Demo()";
        case "todo":
          return "/repo/a.ts:5: TODO: cleanup";
        case "deprecated":
          return "function oldFn (/repo/a.ts:6) - migrate";
        case "annotations":
          return "@Injectable class Service (/repo/a.ts:7)";
        case "module":
          return "auth (src/auth) — 2 files";
        case "deps":
          return "→ db (src/db) [direct]";
        case "dependents":
          return "← api (src/api)";
        case "unused-deps":
          return "⚠ legacy (src/legacy) — unused";
        case "api":
          return "function login login() (/repo/src/auth.ts:12)";
        case "update":
          return "";
        default:
          return "";
      }
    });

    const outline = await client.outline(targetFile);
    expect(outline.symbols[0].name).toBe("Demo");
    expect(outline.meta.contentHash).toBe(
      createHash("sha256").update(targetContent).digest("hex"),
    );

    expect(await client.symbol("Demo")).toEqual({
      name: "Demo",
      kind: "class",
      file: "/repo/file.ts",
      start_line: 1,
      signature: "class Demo",
    });
    expect((await client.search("Demo")).length).toBe(3);
    expect(await client.usages("Demo")).toEqual([
      { file: "/repo/a.ts", line: 8, text: "Demo()", kind: "reference" },
    ]);
    expect((await client.implementations("Demo"))[0].name).toBe("DemoImpl");
    expect((await client.hierarchy("Demo"))?.parents?.[0].name).toBe("Base");
    expect(await client.stats()).toContain("Files: 5");
    expect(await client.listFiles()).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect((await client.refs("Demo")).definitions.length).toBe(1);
    expect((await client.map())?.project_type).toBe("ts");
    expect((await client.conventions())?.architecture).toEqual(["layered"]);
    expect((await client.callers("Demo")).length).toBe(1);
    expect((await client.callTree("Demo"))?.name).toBe("root");
    expect((await client.changed("main")).length).toBe(1);
    expect(
      (await client.unusedSymbols({ exportOnly: true, limit: 5 })).length,
    ).toBe(1);
    expect((await client.fileImports("/repo/a.ts"))[0].source).toBe("./demo");
    expect((await client.agrep("Demo()"))[0].line).toBe(4);
    expect((await client.todo())[0].kind).toBe("TODO");
    expect((await client.deprecated())[0].name).toBe("oldFn");
    expect((await client.annotations("Injectable"))[0].annotation).toBe(
      "Injectable",
    );
    expect((await client.modules())[0].name).toBe("auth");
    expect((await client.moduleDeps("auth"))[0].name).toBe("db");
    expect((await client.moduleDependents("auth"))[0].name).toBe("api");
    expect((await client.unusedDeps("auth"))[0].name).toBe("legacy");
    expect((await client.moduleApi("auth"))[0].name).toBe("login");

    client.indexed = true;
    await client.incrementalUpdate();
    expect(client.exec).toHaveBeenCalledWith(["update"], 15000);
  });

  it("returns safe fallbacks when exec or tooling fails", async () => {
    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = "/bin/ast-index";
    client.ensureIndex = async () => {};
    client.exec = vi.fn(async () => {
      throw new Error("boom");
    });

    expect(await client.search("x")).toEqual([]);
    expect(await client.usages("x")).toEqual([]);
    expect(await client.implementations("x")).toEqual([]);
    expect(await client.hierarchy("x")).toBeNull();
    expect(await client.listFiles()).toEqual([]);
    expect(await client.refs("x")).toEqual({
      definitions: [],
      imports: [],
      usages: [],
    });
    expect(await client.map()).toBeNull();
    expect(await client.conventions()).toBeNull();
    expect(await client.callers("x")).toEqual([]);
    expect(await client.callTree("x")).toBeNull();
    expect(await client.changed()).toEqual([]);
    expect(await client.unusedSymbols()).toEqual([]);
    expect(await client.fileImports("/repo/a.ts")).toEqual([]);
    expect(await client.todo()).toEqual([]);
    expect(await client.deprecated()).toEqual([]);
    expect(await client.annotations("Injectable")).toEqual([]);
    expect(await client.modules()).toEqual([]);
    expect(await client.moduleDeps("auth")).toEqual([]);
    expect(await client.moduleDependents("auth")).toEqual([]);
    expect(await client.unusedDeps("auth")).toEqual([]);
    expect(await client.moduleApi("auth")).toEqual([]);

    client.astGrepAvailable = false;
    await expect(client.agrep("x")).rejects.toThrow(
      "ast-grep (sg) not installed",
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // v0.30.0 — monorepo / long-session improvements (token-pilot-f2u)
  // ──────────────────────────────────────────────────────────────────────

  // ast-index v3.39+ reads AST_INDEX_WALK_UP=1 so read-commands traverse
  // past nested VCS markers (submodule .git, nested Cargo.toml) and reuse
  // a parent-level index. Without this, running find_usages inside a
  // monorepo submodule silently returned empty. We set the flag on every
  // spawn so the fix is zero-config.
  //
  // ESM forbids spying on child_process.execFile, so we take the black-box
  // route: point binaryPath at a tiny shell script that prints the env var
  // back to stdout and run the real exec path end-to-end.
  it("sets AST_INDEX_WALK_UP=1 on every ast-index spawn (monorepo fix)", async () => {
    const { chmod, writeFile } = await import("node:fs/promises");
    const fakeBinary = join(tempDir, "fake-ast-index.sh");
    // Script prints one line the real binary never would, so we can assert
    // on it unambiguously. Works on macOS/Linux CI runners.
    await writeFile(
      fakeBinary,
      '#!/bin/sh\nprintf "WALK_UP=%s\\n" "${AST_INDEX_WALK_UP:-unset}"\n',
    );
    await chmod(fakeBinary, 0o755);

    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = fakeBinary;

    const out = await client.exec(["stats"]);
    expect(out).toContain("WALK_UP=1");

    // Also verify astGrepBinDir still merges into PATH alongside walk-up —
    // walk-up must not clobber other env additions.
    client.astGrepBinDir = "/some/ast-grep/bin";
    const out2 = await client.exec(["stats"]);
    expect(out2).toContain("WALK_UP=1");
  });

  // Branch-switch wiring is in server.ts, but incrementalUpdate is the
  // entry point we expect that wiring to call. It must short-circuit
  // cleanly when the index isn't in a usable state — otherwise a stray
  // checkout during startup would crash.
  it("incrementalUpdate short-circuits when index is not ready", async () => {
    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = "/bin/ast-index";
    const execSpy = vi.spyOn(client, "exec");

    // indexed=false → no-op
    client.indexed = false;
    client.indexDisabled = false;
    client.indexOversized = false;
    await client.incrementalUpdate();
    expect(execSpy).not.toHaveBeenCalled();

    // disabled → no-op
    client.indexed = true;
    client.indexDisabled = true;
    await client.incrementalUpdate();
    expect(execSpy).not.toHaveBeenCalled();

    // oversized → no-op
    client.indexDisabled = false;
    client.indexOversized = true;
    await client.incrementalUpdate();
    expect(execSpy).not.toHaveBeenCalled();
  });

  // 5-minute safety-net ticker. Uses fake timers to verify a tick fires at
  // the configured interval, and that the overlap guard prevents a second
  // tick from starting while the first is still running. stopPeriodicUpdate
  // must clear the interval cleanly (no zombie timer).
  it("startPeriodicUpdate schedules incrementalUpdate at the interval and guards overlap", async () => {
    vi.useFakeTimers();
    try {
      const client = new AstIndexClient(tempDir) as any;
      client.binaryPath = "/bin/ast-index";
      client.indexed = true;
      client.indexDisabled = false;
      client.indexOversized = false;

      let pendingResolve: (() => void) | null = null;
      const updateSpy = vi
        .spyOn(client, "incrementalUpdate")
        .mockImplementation(
          () =>
            new Promise<void>((r) => {
              pendingResolve = r;
            }),
        );

      client.startPeriodicUpdate(60_000); // 1-minute interval for the test
      // Immediately after start — no tick yet
      expect(updateSpy).not.toHaveBeenCalled();

      // Advance 1 minute → one tick fires
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updateSpy).toHaveBeenCalledTimes(1);

      // Advance another minute while the first tick is still pending →
      // overlap guard blocks a second call
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updateSpy).toHaveBeenCalledTimes(1);

      // Resolve the in-flight update → guard releases
      pendingResolve!();
      await Promise.resolve(); // let the .finally callback run

      // Next tick fires normally
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updateSpy).toHaveBeenCalledTimes(2);

      // Stop — no more ticks
      client.stopPeriodicUpdate();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(updateSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("startPeriodicUpdate is idempotent — a second call does not stack timers", () => {
    const client = new AstIndexClient(tempDir) as any;
    client.startPeriodicUpdate(60_000);
    const first = client.periodicTimer;
    client.startPeriodicUpdate(60_000); // second call is a no-op
    expect(client.periodicTimer).toBe(first);
    client.stopPeriodicUpdate();
    expect(client.periodicTimer).toBeNull();
    // stopPeriodicUpdate when no timer is running is also safe
    client.stopPeriodicUpdate();
    expect(client.periodicTimer).toBeNull();
  });
});
