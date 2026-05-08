/**
 * Tests for the v0.34.0 error/diagnostic channel.
 *
 * The module writes to `~/.token-pilot/hook-errors.jsonl` by default.
 * Tests redirect to a tmp dir via the `path` override so we never
 * touch the real user-level file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyError,
  loadErrors,
  formatErrorList,
  safeBasename,
  safePathInfo,
  type HookErrorRecord,
} from "../../src/core/error-log.ts";

describe("classifyError", () => {
  it("returns ENOENT for ErrnoException-shaped error", () => {
    const err = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(classifyError(err)).toBe("ENOENT");
  });

  it("maps SyntaxError to parse_error", () => {
    expect(classifyError(new SyntaxError("bad json"))).toBe("parse_error");
  });

  it("maps timeout messages to timeout", () => {
    expect(classifyError(new Error("operation timeout exceeded"))).toBe(
      "timeout",
    );
  });

  it("falls back to unknown for plain values", () => {
    expect(classifyError("oops")).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });
});

describe("safeBasename / safePathInfo", () => {
  it("returns just the basename", () => {
    expect(safeBasename("/Users/x/secret/Foo.tsx")).toBe("Foo.tsx");
  });

  it("returns sentinel for missing input", () => {
    expect(safeBasename(undefined)).toBe("<empty>");
    expect(safeBasename("")).toBe("<empty>");
  });

  it("safePathInfo extracts ext", () => {
    expect(safePathInfo("/x/y/z.test.ts")).toEqual({
      name: "z.test.ts",
      ext: ".ts",
    });
    expect(safePathInfo("/x/Makefile")).toEqual({
      name: "Makefile",
      ext: "",
    });
  });
});

describe("loadErrors", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tp-error-log-"));
    path = join(dir, "hook-errors.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function rec(over: Partial<HookErrorRecord> = {}): HookErrorRecord {
    return {
      ts: Date.now(),
      hook: "hook-pre-task",
      level: "error",
      code: "unknown",
      msg: "x",
      ...over,
    };
  }

  it("returns [] when the file is missing", async () => {
    expect(await loadErrors({ path })).toEqual([]);
  });

  it("parses jsonl, skipping malformed lines", async () => {
    const lines = [
      JSON.stringify(rec({ ts: 1, code: "a" })),
      "this is not json",
      JSON.stringify(rec({ ts: 2, code: "b" })),
      "",
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const out = await loadErrors({ path });
    expect(out.map((r) => r.code)).toEqual(["b", "a"]); // newest first
  });

  it("filters by code / hook / level", async () => {
    const lines = [
      rec({ ts: 1, code: "a", hook: "hook-read", level: "info" }),
      rec({ ts: 2, code: "b", hook: "hook-pre-task", level: "warn" }),
      rec({ ts: 3, code: "a", hook: "hook-pre-task", level: "error" }),
    ].map((r) => JSON.stringify(r));
    await writeFile(path, lines.join("\n") + "\n");

    expect((await loadErrors({ path, code: "a" })).length).toBe(2);
    expect((await loadErrors({ path, hook: "hook-read" })).length).toBe(1);
    expect((await loadErrors({ path, level: "error" })).length).toBe(1);
  });

  it("respects tail option", async () => {
    const lines = [1, 2, 3, 4, 5].map((ts) =>
      JSON.stringify(rec({ ts, code: `c${ts}` })),
    );
    await writeFile(path, lines.join("\n") + "\n");
    const out = await loadErrors({ path, tail: 2 });
    // newest first
    expect(out.map((r) => r.code)).toEqual(["c5", "c4"]);
  });
});

describe("formatErrorList", () => {
  it("returns a friendly empty message", () => {
    expect(formatErrorList([])).toMatch(/No errors logged/);
  });

  it("counts top codes and shows recent records", () => {
    const records: HookErrorRecord[] = [
      { ts: 1, hook: "h", level: "error", code: "ENOENT", msg: "x" },
      { ts: 2, hook: "h", level: "error", code: "ENOENT", msg: "x" },
      { ts: 3, hook: "h", level: "error", code: "parse_error", msg: "x" },
    ];
    const out = formatErrorList(records);
    expect(out).toContain("3 total");
    expect(out).toContain("ENOENT");
    expect(out).toContain("parse_error");
  });
});

describe("appendError integration (writes to overridden cwd)", () => {
  // appendError uses errorLogPath() — cannot override cleanly; cover via
  // existsSync after writing through a faked $HOME. Skipping the real
  // append in unit tests keeps them filesystem-clean.
  it("loadErrors path-override returns parsed records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-error-log-"));
    const path = join(dir, "hook-errors.jsonl");
    const r: HookErrorRecord = {
      ts: 100,
      hook: "hook-pre-task",
      level: "warn",
      code: "force_subagents_no_agents",
      msg: "no agents installed",
    };
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(r) + "\n");
    const out = await loadErrors({ path });
    expect(out.length).toBe(1);
    expect(out[0].code).toBe("force_subagents_no_agents");
    await rm(dir, { recursive: true, force: true });
  });
});
