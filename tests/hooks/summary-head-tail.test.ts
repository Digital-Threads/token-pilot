import { describe, it, expect } from "vitest";
import { parseHeadTailSummary } from "../../src/hooks/summary-head-tail.js";

describe("parseHeadTailSummary", () => {
  it("returns first 40 + last 20 lines for a large file", () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const summary = parseHeadTailSummary(content, "big.ts");

    expect(summary.signals.length).toBe(60); // 40 head + 20 tail
    expect(summary.totalLines).toBe(200);
    expect(summary.note).toMatch(/parser unavailable|head\+tail/i);
  });

  it('labels all signals as kind "raw"', () => {
    const content = Array.from({ length: 100 }, (_, i) => `x${i}`).join("\n");
    const summary = parseHeadTailSummary(content, "mid.js");
    expect(summary.signals.every((s) => s.kind === "raw")).toBe(true);
  });

  it("preserves 1-based line numbers for both head and tail", () => {
    const content = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join(
      "\n",
    );
    const summary = parseHeadTailSummary(content, "x.ts");

    // First 40 should be lines 1..40
    expect(summary.signals[0].line).toBe(1);
    expect(summary.signals[39].line).toBe(40);

    // Last 20 should be lines 81..100
    expect(summary.signals[40].line).toBe(81);
    expect(summary.signals[59].line).toBe(100);
  });

  it("returns every line verbatim when file is smaller than head+tail budget", () => {
    const content = ["a", "b", "c", "d", "e"].join("\n");
    const summary = parseHeadTailSummary(content, "tiny.ts");

    expect(summary.signals).toHaveLength(5);
    expect(summary.signals.map((s) => s.text)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(summary.signals.map((s) => s.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns every line verbatim when file is exactly head+tail budget", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const summary = parseHeadTailSummary(content, "sixty.ts");
    expect(summary.signals).toHaveLength(60);
  });

  it("skips the note when every line is included (no truncation happened)", () => {
    const content = ["a", "b", "c"].join("\n");
    const summary = parseHeadTailSummary(content, "tiny.ts");
    expect(summary.note).toBeUndefined();
  });

  it("handles an empty file without crashing", () => {
    const summary = parseHeadTailSummary("", "empty.ts");
    expect(summary.totalLines).toBe(1);
    expect(summary.signals.length).toBeLessThanOrEqual(1);
  });

  it("extracts language from the file extension", () => {
    const summary = parseHeadTailSummary("abc", "foo.py");
    expect(summary.language).toBe("py");
  });

  it("estimates tokens from the full original content, not the truncated view", () => {
    const content = Array.from(
      { length: 500 },
      () => "something something",
    ).join("\n");
    const summary = parseHeadTailSummary(content, "x.ts");
    expect(summary.estimatedTokens).toBeGreaterThan(1000);
  });
});
