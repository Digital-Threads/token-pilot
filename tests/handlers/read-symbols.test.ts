/**
 * v0.23.6 — read_symbols guard tests.
 *
 * The bug a field report surfaced: read_symbols returned −16 % vs raw Read
 * when the pr-reviewer subagent asked for nearly every symbol of a file.
 * The batch header + N × per-symbol metadata pushed the total above the
 * whole-file size. Now the handler detects this shape (≥70 % coverage,
 * ≥3 symbols) and refuses with a short advisory pointing at smart_read.
 *
 * Covers: guard trips, guard does not trip, guard ignores when AST missing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReadSymbols } from "../../src/handlers/read-symbols.ts";
import { ContextRegistry } from "../../src/core/context-registry.ts";
import { FileCache } from "../../src/core/file-cache.ts";
import { SymbolResolver } from "../../src/core/symbol-resolver.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-rs-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Minimal stub astIndex that returns a pre-baked structure. */
function stubAst(structure: any) {
  return {
    outline: async () => structure,
  } as any;
}

function makeFile(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("handleReadSymbols guard", () => {
  it("refuses when ≥70% of file is requested via 3+ symbols", async () => {
    const filePath = join(tempDir, "big.ts");
    await writeFile(filePath, makeFile(100));

    const structure = {
      path: filePath,
      symbols: [
        {
          name: "a",
          kind: "function",
          location: { startLine: 1, endLine: 30, lineCount: 30 },
          children: [],
          references: [],
        },
        {
          name: "b",
          kind: "function",
          location: { startLine: 31, endLine: 60, lineCount: 30 },
          children: [],
          references: [],
        },
        {
          name: "c",
          kind: "function",
          location: { startLine: 61, endLine: 90, lineCount: 30 },
          children: [],
          references: [],
        },
      ],
    };

    const reg = new ContextRegistry();
    const cache = new FileCache(100, 200);
    const resolver = new SymbolResolver(stubAst(structure));
    const res = await handleReadSymbols(
      { path: filePath, symbols: ["a", "b", "c"] },
      tempDir,
      resolver,
      cache,
      reg,
      stubAst(structure),
    );
    const text = res.content[0].text;
    expect(text).toMatch(/ADVISORY/);
    expect(text).toMatch(/≥70%/);
    expect(text).toMatch(/smart_read/);
    // Must NOT contain full source bodies
    expect(text).not.toMatch(/SYMBOL 1\/3:/);
  });

  it("passes through when <70% of file is requested", async () => {
    const filePath = join(tempDir, "ok.ts");
    await writeFile(filePath, makeFile(100));
    const structure = {
      path: filePath,
      symbols: [
        {
          name: "tiny",
          kind: "function",
          location: { startLine: 1, endLine: 10, lineCount: 10 },
          children: [],
          references: [],
        },
        {
          name: "large1",
          kind: "function",
          location: { startLine: 11, endLine: 55, lineCount: 45 },
          children: [],
          references: [],
        },
        {
          name: "large2",
          kind: "function",
          location: { startLine: 56, endLine: 100, lineCount: 45 },
          children: [],
          references: [],
        },
      ],
    };

    const reg = new ContextRegistry();
    const cache = new FileCache(100, 200);
    const resolver = new SymbolResolver(stubAst(structure));
    const res = await handleReadSymbols(
      { path: filePath, symbols: ["tiny"] }, // 10% of file
      tempDir,
      resolver,
      cache,
      reg,
      stubAst(structure),
    );
    const text = res.content[0].text;
    expect(text).not.toMatch(/ADVISORY/);
    expect(text).toMatch(/SYMBOL 1\/1: tiny/);
  });

  it("catches Vue-SFC-style overlapping ranges (count-based, not line-based)", async () => {
    // v0.24.1 regression: ast-index parser bugs on arrow-functions / Vue
    // SFCs / TS types return overlapping ranges that inflate sum(lineCount).
    // Line-based guard missed this case. Count-based guard catches it:
    // 6 symbols requested, 6 total in structure → 100% coverage.
    const filePath = join(tempDir, "useCart.ts");
    await writeFile(filePath, makeFile(60));
    const structure = {
      path: filePath,
      // Every "symbol" bogusly claims lines 1-51 (overlapping ranges as
      // observed on a real Vue/TS file in the field report)
      symbols: Array.from({ length: 6 }, (_, i) => ({
        name: `sym${i}`,
        kind: "function",
        location: { startLine: 1, endLine: 51, lineCount: 51 },
        children: [],
        references: [],
      })),
    };

    const reg = new ContextRegistry();
    const cache = new FileCache(100, 200);
    const resolver = new SymbolResolver(stubAst(structure));
    const res = await handleReadSymbols(
      {
        path: filePath,
        symbols: ["sym0", "sym1", "sym2", "sym3", "sym4", "sym5"],
      },
      tempDir,
      resolver,
      cache,
      reg,
      stubAst(structure),
    );
    const text = res.content[0].text;
    expect(text).toMatch(/ADVISORY/);
    expect(text).toMatch(/6\/6/);
  });

  it("does not trip when fewer than 3 symbols requested", async () => {
    const filePath = join(tempDir, "two.ts");
    await writeFile(filePath, makeFile(100));
    const structure = {
      path: filePath,
      symbols: [
        {
          name: "only-one",
          kind: "function",
          location: { startLine: 1, endLine: 95, lineCount: 95 },
          children: [],
          references: [],
        },
      ],
    };

    const reg = new ContextRegistry();
    const cache = new FileCache(100, 200);
    const resolver = new SymbolResolver(stubAst(structure));
    const res = await handleReadSymbols(
      { path: filePath, symbols: ["only-one"] }, // 95% but N=1
      tempDir,
      resolver,
      cache,
      reg,
      stubAst(structure),
    );
    const text = res.content[0].text;
    expect(text).not.toMatch(/ADVISORY/);
    expect(text).toMatch(/SYMBOL 1\/1/);
  });
});
