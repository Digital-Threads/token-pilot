/**
 * 1.0.2 audit, item 14 — the Read gate counted lines only, so a one-line
 * 317 KB minified bundle passed whole; and its extension list missed
 * .cjs/.mts/.cts that the shell gate knew.
 */
import { describe, expect, it } from "vitest";
import { decideReadGate, decideReadGateFromStats, isCodeFile } from "../../src/hooks/read-gate.ts";

describe("Read gate — size, not just lines", () => {
  it("gates a one-line minified bundle", () => {
    const content = "var a=1;".repeat(40_000); // ~320 KB, one line
    expect(decideReadGate({ filePath: "dist/app.min.js", content, offset: null, limit: null, threshold: 300 }).kind).toBe("gate");
  });

  it("gates a huge file measured by stats only", () => {
    expect(
      decideReadGateFromStats({ filePath: "a.js", lineCount: 1, bytes: 5_000_000, offset: null, limit: null, threshold: 300 }).kind,
    ).toBe("gate");
  });

  it("passes an ordinary small file", () => {
    const content = "export const a = 1;\n".repeat(50);
    expect(decideReadGate({ filePath: "a.ts", content, offset: null, limit: null, threshold: 300 }).kind).toBe("pass");
  });

  it("knows .cjs, .mts and .cts as code", () => {
    for (const f of ["a.cjs", "a.mts", "a.cts"]) expect(isCodeFile(f)).toBe(true);
  });
});
