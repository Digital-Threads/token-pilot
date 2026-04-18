/**
 * v0.26.1 — detectSavingsCategoryPure unit tests.
 *
 * Guards the accounting fix that turns small-file pass-through from
 * -2% "negative savings" into honest 0%. Without this classification,
 * the session-analytics recorder claims wouldBe=fullFile for tool
 * calls that didn't actually compress anything, and the overhead of
 * smart_read's tiny header shows up as negative savings.
 */
import { describe, it, expect } from "vitest";
import { detectSavingsCategoryPure } from "../../src/server/token-estimates.ts";

describe("detectSavingsCategoryPure", () => {
  it('returns "dedup" for REMINDER: prefix', () => {
    expect(detectSavingsCategoryPure("REMINDER: already loaded earlier")).toBe(
      "dedup",
    );
  });

  it('returns "dedup" for DEDUP: prefix', () => {
    expect(detectSavingsCategoryPure("DEDUP: exact match")).toBe("dedup");
  });

  it('returns "none" for small-file pass-through marker', () => {
    const text =
      "FILE: src/utils.ts (42 lines — returned in full, below threshold)\n\ncode...";
    expect(detectSavingsCategoryPure(text)).toBe("none");
  });

  it('returns "none" when outline is not smaller than the raw file', () => {
    const text =
      "FILE: src/tiny.ts (10 lines — returned in full, outline not smaller)\n\ncode...";
    expect(detectSavingsCategoryPure(text)).toBe("none");
  });

  it('returns "compression" for structured smart_read output', () => {
    const text =
      "FILE: src/big.ts (800 lines)\nSTRUCTURE:\n  class Foo { ... }\n";
    expect(detectSavingsCategoryPure(text)).toBe("compression");
  });

  it('defaults to "compression" for generic handler text', () => {
    expect(detectSavingsCategoryPure("arbitrary text with no marker")).toBe(
      "compression",
    );
  });
});
