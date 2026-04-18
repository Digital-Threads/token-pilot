import { describe, it, expect } from "vitest";
import { formatDenyMessage } from "../../src/hooks/format-deny-message.js";
import type { HookSummary } from "../../src/hooks/summary-types.js";

function mk(partial: Partial<HookSummary> = {}): HookSummary {
  return {
    signals: [],
    totalLines: 500,
    estimatedTokens: 2000,
    language: "ts",
    ...partial,
  };
}

describe("formatDenyMessage", () => {
  it("renders header with file path, line count and estimated tokens", () => {
    const summary = mk({
      signals: [{ line: 1, kind: "declaration", text: "function f()" }],
    });
    const msg = formatDenyMessage({
      filePath: "src/big.ts",
      summary,
      tier: "regex",
    });
    expect(msg).toMatch(/src\/big\.ts/);
    expect(msg).toMatch(/500 lines/);
    expect(msg).toMatch(/2000 tokens/);
  });

  it("renders an Imports section when any signal is kind=import", () => {
    const summary = mk({
      signals: [
        { line: 1, kind: "import", text: 'import { x } from "./x"' },
        { line: 5, kind: "declaration", text: "function f()" },
      ],
    });
    const msg = formatDenyMessage({ filePath: "x.ts", summary, tier: "regex" });
    expect(msg).toMatch(/=== Imports ===/);
    expect(msg).toMatch(/L1: import/);
  });

  it("renders Exports and Declarations sections when populated", () => {
    const summary = mk({
      signals: [
        { line: 10, kind: "export", text: "export function greet()" },
        { line: 20, kind: "declaration", text: "function internal()" },
      ],
    });
    const msg = formatDenyMessage({
      filePath: "x.ts",
      summary,
      tier: "ast-index",
    });
    expect(msg).toMatch(/=== Exports/);
    expect(msg).toMatch(/L10: export function greet/);
    expect(msg).toMatch(/=== Declarations ===/);
    expect(msg).toMatch(/L20: function internal/);
  });

  it("skips sections with no signals", () => {
    const summary = mk({
      signals: [{ line: 1, kind: "declaration", text: "class C {}" }],
    });
    const msg = formatDenyMessage({ filePath: "x.ts", summary, tier: "regex" });
    expect(msg).not.toMatch(/=== Imports ===/);
    expect(msg).not.toMatch(/=== Exports/);
    expect(msg).toMatch(/=== Declarations ===/);
  });

  it("renders a Content preview section for head+tail raw signals", () => {
    const summary = mk({
      signals: [
        { line: 1, kind: "raw", text: "line 1" },
        { line: 200, kind: "raw", text: "line 200" },
      ],
      note: "parser unavailable — head+tail only",
    });
    const msg = formatDenyMessage({
      filePath: "x.ts",
      summary,
      tier: "head-tail",
    });
    expect(msg).toMatch(/Content preview/);
    expect(msg).toMatch(/L1: line 1/);
    expect(msg).toMatch(/L200: line 200/);
  });

  it("includes the summary.note on its own line when present", () => {
    const summary = mk({
      signals: [{ line: 1, kind: "raw", text: "x" }],
      note: "parser unavailable — head+tail only",
    });
    const msg = formatDenyMessage({
      filePath: "x.ts",
      summary,
      tier: "head-tail",
    });
    expect(msg).toMatch(/parser unavailable/);
  });

  it('always ends with a "How to proceed" footer that cites bounded Read and read_for_edit', () => {
    const summary = mk({
      signals: [{ line: 1, kind: "declaration", text: "f" }],
    });
    const msg = formatDenyMessage({ filePath: "x.ts", summary, tier: "regex" });
    expect(msg).toMatch(/How to proceed/);
    expect(msg).toMatch(/offset/);
    expect(msg).toMatch(/read_for_edit/);
    expect(msg).toMatch(/TOKEN_PILOT_BYPASS/);
  });

  it("respects the maxTokens cap: trims the signal list and appends a trimmed note", () => {
    const manySignals = Array.from({ length: 500 }, (_, i) => ({
      line: i + 1,
      kind: "declaration" as const,
      text: `symbolName${i}(long_argument_list_here_to_inflate_token_count)`,
    }));
    const summary = mk({ signals: manySignals });
    const short = formatDenyMessage({
      filePath: "x.ts",
      summary,
      tier: "regex",
      maxTokens: 400,
    });
    const long = formatDenyMessage({
      filePath: "x.ts",
      summary,
      tier: "regex",
      maxTokens: 2000,
    });
    expect(short.length).toBeLessThan(long.length);
    expect(short).toMatch(/trimmed to fit budget/);
  });

  it("omits the trimmed-note when nothing was trimmed", () => {
    const summary = mk({
      signals: [{ line: 1, kind: "declaration", text: "f" }],
    });
    const msg = formatDenyMessage({
      filePath: "x.ts",
      summary,
      tier: "regex",
      maxTokens: 2000,
    });
    expect(msg).not.toMatch(/trimmed to fit budget/);
  });
});
