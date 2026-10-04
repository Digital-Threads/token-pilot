/**
 * The Read gate's decision, separated from the file I/O so the CLI hook and
 * the Claude Code mod reach the same verdict on the same content.
 */
import { describe, it, expect } from "vitest";
import {
  decideReadGate,
  decideReadGateFromStats,
  isCodeFile,
  outlineHeader,
  spanCannotExceed,
} from "../../src/hooks/read-gate.ts";

const big = "const x = 1;\n".repeat(400);

describe("decideReadGate", () => {
  it("passes non-code files and bounded spans under the threshold", () => {
    expect(isCodeFile("a.md")).toBe(false);
    expect(
      decideReadGate({ filePath: "a.ts", content: big, offset: 1, limit: 50, threshold: 300 }).kind,
    ).toBe("pass");
  });

  it("gates a whole-file read of a big code file", () => {
    const gate = decideReadGate({
      filePath: "a.ts",
      content: big,
      offset: null,
      limit: null,
      threshold: 300,
    });

    expect(gate).toMatchObject({ kind: "gate", lineCount: 401, spanLines: 401 });
    if (gate.kind === "gate") expect(gate.estTokens).toBeGreaterThan(0);
  });
});

describe("outlineHeader", () => {
  it("says plainly that the result is an outline and how to get exact text", () => {
    const h = outlineHeader("src/a.ts", 900, 7000, "mcp__plugin_token-pilot_token-pilot__");

    expect(h).toContain("src/a.ts has 900 lines");
    expect(h).toContain("not the file text");
    expect(h).toContain("offset/limit");
    expect(h).toContain("read_for_edit");
  });
});

describe("spanCannotExceed", () => {
  it("knows a bounded read fits without reading the file", () => {
    expect(spanCannotExceed(null, 100, 300)).toBe(true);
    expect(spanCannotExceed(500, 300, 300)).toBe(true);
    expect(spanCannotExceed(null, 400, 300)).toBe(false);
    expect(spanCannotExceed(50, null, 300)).toBe(false);
    expect(spanCannotExceed(null, null, 300)).toBe(false);
  });
});

describe("decideReadGateFromStats", () => {
  it("gates a file too big to read whole, from its line count and size", () => {
    const gate = decideReadGateFromStats({
      filePath: "src/huge.ts",
      lineCount: 200_000,
      bytes: 6_000_000,
      offset: null,
      limit: null,
      threshold: 300,
    });

    expect(gate).toMatchObject({ kind: "gate", lineCount: 200_000, spanLines: 200_000, estTokens: 1_500_000 });
  });

  it("passes non-code files and bounded spans", () => {
    const base = { lineCount: 200_000, bytes: 6_000_000, threshold: 300 };

    expect(decideReadGateFromStats({ ...base, filePath: "a.log", offset: null, limit: null }).kind).toBe("pass");
    expect(decideReadGateFromStats({ ...base, filePath: "a.ts", offset: 10, limit: 50 }).kind).toBe("pass");
  });
});

describe("limit 0 is no limit", () => {
  // Claude Code's Read schema rejects it (a positive integer), and Codex or
  // another client may not. Counting it as no limit errs on the gate's side.
  const big = "const x = 1;\n".repeat(800);

  it("gates a whole-file Read sent with limit 0", () => {
    expect(spanCannotExceed(null, 0, 300)).toBe(false);
    expect(decideReadGate({ filePath: "a.ts", content: big, offset: null, limit: 0, threshold: 300 }).kind).toBe("gate");
  });
});
