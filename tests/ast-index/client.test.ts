import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

import {
  AstIndexClient,
  computeHasGitMarker,
} from "../../src/ast-index/client.js";
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
    // Real ast-index 3.50 layouts (see tests/fixtures/ast-index/).
    expect(parseModuleListText("Modules matching '%auth%':\n  auth: src/auth\n")).toEqual([
      { name: "auth", path: "src/auth" },
    ]);
    expect(parseModuleDepText("Dependencies of 'app' (1):\n  implementation:\n    db (src/db)\n")).toEqual([
      { name: "db", path: "src/db", type: "implementation" },
    ]);
    expect(parseUnusedDepsText("=== Unused ===\n  ✗ legacy (implementation)\n")).toEqual([
      { name: "legacy", path: "legacy", reason: "implementation dependency, no symbol used" },
    ]);
    expect(
      parseModuleApiText("Public API of 'auth' (1):\n  src/auth.ts:12\n    function login() {\n"),
    ).toEqual([
      {
        kind: "function",
        name: "login",
        signature: "function login() {",
        file: "src/auth.ts",
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

    // flat: nesting comes from real ranges in buildFileStructure, not indentation
    expect(outlineEntries.map((e) => e.name)).toEqual(["MyClass", "methodA", "freeFn"]);
    expect(outlineEntries[1].end_line).toBe(7);
    expect(outlineEntries[2].end_line).toBe(18);

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
    // both methods, including the async one the old regex missed
    expect(pyStructure.symbols[0].children.map((c) => c.name)).toEqual(["build", "run"]);
    expect(pyStructure.symbols[0].children[0].static).toBe(true);
    expect(pyStructure.symbols[0].children[1].async).toBe(true);

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

  it("backtracks python method end lines around decorators", async () => {
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
        case "query":
          return JSON.stringify({ rows: [{ path: "a.ts" }, { path: "b.ts" }] });
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
          return "Call tree for 'root':\n  root\n";
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
          return "Modules matching '%%':\n  auth: src/auth\n";
        case "deps":
          return "Dependencies of 'auth' (1):\n  api:\n    db (src/db)\n";
        case "dependents":
          return "Modules depending on 'auth' (1):\n  via implementation (1):\n    api (src/api)\n";
        case "unused-deps":
          return "=== Unused ===\n  ✗ legacy (implementation)\n";
        case "api":
          return "Public API of 'auth' (1):\n  src/auth.ts:12\n    function login() {\n";
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
    expect(await client.listFiles()).toEqual(["a.ts", "b.ts"]);
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
  // a parent-level index. We set the flag ONLY when projectRoot is a bare
  // subdir with no `.git` marker of its own — a repo/worktree root must NOT
  // walk up, or a nested worktree (`main-repo/.worktrees/feature`) would
  // escape to the main repo's parent index and return the wrong files.
  //
  // ESM forbids spying on child_process.execFile, so we take the black-box
  // route: point binaryPath at a tiny shell script that prints the env var
  // back to stdout and run the real exec path end-to-end.
  //
  // Script prints one line the real binary never would, so we can assert on
  // it unambiguously. Works on macOS/Linux CI runners.
  const walkUpProbe = '#!/bin/sh\nprintf "WALK_UP=%s\\n" "${AST_INDEX_WALK_UP:-unset}"\n';

  it("sets AST_INDEX_WALK_UP=1 when projectRoot has no .git marker (bare subdir)", async () => {
    const { chmod, writeFile } = await import("node:fs/promises");
    // tempDir is a fresh mkdtemp — no `.git`, i.e. a bare subdir.
    const fakeBinary = join(tempDir, "fake-ast-index.sh");
    await writeFile(fakeBinary, walkUpProbe);
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

  it("skips AST_INDEX_WALK_UP when projectRoot is a git root (.git present)", async () => {
    const { chmod, mkdtemp: mkdtempFs, writeFile } = await import(
      "node:fs/promises"
    );
    // A repo/worktree root: a `.git` entry exists at projectRoot. Use a
    // file (the worktree/submodule gitlink shape) — a directory counts too.
    const repoRoot = await mkdtempFs(join(tmpdir(), "token-pilot-ast-gitroot-"));
    await writeFile(join(repoRoot, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const fakeBinary = join(repoRoot, "fake-ast-index.sh");
    await writeFile(fakeBinary, walkUpProbe);
    await chmod(fakeBinary, 0o755);

    const client = new AstIndexClient(repoRoot) as any;
    client.binaryPath = fakeBinary;

    const out = await client.exec(["stats"]);
    expect(out).toContain("WALK_UP=unset");

    await rm(repoRoot, { recursive: true, force: true });
  });

  it("computeHasGitMarker detects .git dir, .git file, and its absence", async () => {
    const { mkdir, mkdtemp: mkdtempFs, writeFile } = await import(
      "node:fs/promises"
    );
    const dirRepo = await mkdtempFs(join(tmpdir(), "token-pilot-git-dir-"));
    await mkdir(join(dirRepo, ".git"));
    expect(computeHasGitMarker(dirRepo)).toBe(true);

    const fileRepo = await mkdtempFs(join(tmpdir(), "token-pilot-git-file-"));
    await writeFile(join(fileRepo, ".git"), "gitdir: /x\n");
    expect(computeHasGitMarker(fileRepo)).toBe(true);

    const bare = await mkdtempFs(join(tmpdir(), "token-pilot-git-none-"));
    expect(computeHasGitMarker(bare)).toBe(false);

    await rm(dirRepo, { recursive: true, force: true });
    await rm(fileRepo, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
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

  // ──────────────────────────────────────────────────────────────────────
  // ast-index 3.46+ — swap-and-restore: a rebuild that aborts keeps the
  // previous index. buildIndex must detect a usable preserved index in its
  // failure path and use it instead of throwing (which would drop us to raw
  // reads). Mirrors the existing lock-case recovery already in that catch.
  // ──────────────────────────────────────────────────────────────────────
  it("recovers a preserved index when rebuild fails (3.46+ swap-and-restore)", async () => {
    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = "/bin/ast-index";

    // First stats (top of buildIndex) → no index yet, forcing the rebuild
    // path. rebuild rejects, but the next stats reports a healthy index that
    // the binary preserved. buildIndex should use it, not rethrow.
    let statsCalls = 0;
    client.exec = vi.fn(async (args: string[]) => {
      if (args.includes("stats")) {
        statsCalls += 1;
        if (statsCalls === 1) return '{"stats":{"file_count":0}}';
        return '{"stats":{"file_count":123}}';
      }
      if (args[0] === "rebuild") {
        throw new Error("candidate scan aborted");
      }
      return "";
    });

    await expect(client.buildIndex()).resolves.toBeUndefined();
    expect(client.indexed).toBe(true);
  });

  // explore() maps the ast-index 3.48 JSON (snake_case) into the typed
  // result, tolerating missing arrays and passing --rwr by default.
  it("explore() maps json to the typed result and passes --rwr by default", async () => {
    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = "/bin/ast-index";
    client.ensureIndex = async () => {};

    const execMock = vi.fn(async (..._args: unknown[]) =>
      JSON.stringify({
        dominant_language: "ts",
        query: "AstIndexClient buildIndex",
        files: [
          { line: 54, path: "src/ast-index/client.ts", source: "   54\tclass" },
        ],
        symbols: [
          {
            kind: "class",
            line: 54,
            name: "AstIndexClient",
            path: "src/ast-index/client.ts",
            score: 1000,
            vendor: false,
          },
        ],
        neighbours: [
          {
            kind: "function",
            line: 69,
            link: "caller",
            name: "runSummaryPipeline",
            path: "src/hooks/summary-pipeline.ts",
          },
        ],
        tests: [
          {
            source: "src/ast-index/client.ts",
            tests: ["tests/ast-index/client.test.ts"],
          },
        ],
      }),
    );
    client.exec = execMock;

    const result = await client.explore("AstIndexClient buildIndex");
    expect(result.dominantLanguage).toBe("ts");
    expect(result.symbols[0].name).toBe("AstIndexClient");
    expect(result.symbols[0].vendor).toBe(false);
    expect(result.files[0].path).toBe("src/ast-index/client.ts");
    expect(result.neighbours[0].link).toBe("caller");
    expect(result.tests[0].tests).toEqual(["tests/ast-index/client.test.ts"]);

    // Default graph ON → --rwr present; query passed as a single string.
    const args = execMock.mock.calls[0][0] as string[];
    expect(args).toContain("--rwr");
    expect(args).toContain("AstIndexClient buildIndex");

    // graph: false → no --rwr
    execMock.mockClear();
    await client.explore("x", { graph: false });
    expect(execMock.mock.calls[0][0]).not.toContain("--rwr");
  });

  it("explore() returns an empty result on exec failure", async () => {
    const client = new AstIndexClient(tempDir) as any;
    client.binaryPath = "/bin/ast-index";
    client.ensureIndex = async () => {};
    client.exec = vi.fn(async () => {
      throw new Error("boom");
    });

    const result = await client.explore("x");
    expect(result).toEqual({
      query: "x",
      dominantLanguage: "",
      symbols: [],
      files: [],
      neighbours: [],
      tests: [],
    });
  });

  // Real output: ast-index 3.50 prints a bare array, 3.56 wraps the same
  // entries in { schema_version, items, pagination }.
  describe.each(["3.50", "3.56"])("list JSON of ast-index %s", (version) => {
    const fixture = (name: string) =>
      readFileSync(join(__dirname, "../fixtures/ast-index", `${name}-${version}.json`), "utf-8");
    const clientAnswering = (json: string) => {
      const client = new AstIndexClient(tempDir) as any;
      client.binaryPath = "/bin/ast-index";
      client.ensureIndex = async () => {};
      client.exec = async () => json;

      return client;
    };

    it("symbol() finds the definition", async () => {
      expect(await clientAnswering(fixture("symbol")).symbol("SymbolResolver")).toEqual({
        name: "SymbolResolver",
        kind: "class",
        file: "src/core/symbol-resolver.ts",
        start_line: 5,
        signature: "export class SymbolResolver {",
      });
    });

    it("usages() lists every call site", async () => {
      const usages = await clientAnswering(fixture("usages")).usages("handleExplore");

      expect(usages).toHaveLength(8);
      expect(usages[0]).toEqual({
        file: "src/server.ts",
        line: 1406,
        text: "const exResult = await handleExplore(exArgs, projectRoot, astIndex);",
        kind: "reference",
      });
    });
  });
});
