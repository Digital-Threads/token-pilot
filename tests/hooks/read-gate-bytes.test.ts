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

  // Review 1.0.2 — the deny and session texts promise that a Read with
  // offset/limit within the line threshold passes; the byte check is for
  // whole-file reads. 400 lines × 150 chars: wider than 100 chars a line.
  const wide = ("x".repeat(149) + "\n").repeat(400);

  it("passes an offset/limit window within the line threshold, however wide its lines", () => {
    expect(decideReadGate({ filePath: "a.ts", content: wide, offset: 0, limit: 250, threshold: 300 }).kind).toBe("pass");
    expect(decideReadGate({ filePath: "a.ts", content: wide, offset: 150, limit: 300, threshold: 300 }).kind).toBe("pass");
    expect(decideReadGate({ filePath: "a.ts", content: wide, offset: 200, limit: null, threshold: 300 }).kind).toBe("pass");
    expect(
      decideReadGateFromStats({ filePath: "a.ts", lineCount: 400, bytes: wide.length, offset: 0, limit: 250, threshold: 300 }).kind,
    ).toBe("pass");
  });

  it("still gates a whole-file read of wide lines, and a window over the threshold", () => {
    const short = ("x".repeat(149) + "\n").repeat(250);
    expect(decideReadGate({ filePath: "a.ts", content: short, offset: null, limit: null, threshold: 300 }).kind).toBe("gate");
    expect(decideReadGate({ filePath: "a.ts", content: wide, offset: 0, limit: 350, threshold: 300 }).kind).toBe("gate");
  });

  it("knows .cjs, .mts and .cts as code", () => {
    for (const f of ["a.cjs", "a.mts", "a.cts"]) expect(isCodeFile(f)).toBe(true);
  });
});
