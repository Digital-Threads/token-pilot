import { describe, it, expect, vi } from "vitest";
import { runSummaryPipeline } from "../../src/hooks/summary-pipeline.js";
import type { HookSummary } from "../../src/hooks/summary-types.js";

function mkSummary(overrides: Partial<HookSummary> = {}): HookSummary {
  return {
    signals: [{ line: 1, kind: "declaration", text: "function f" }],
    totalLines: 10,
    estimatedTokens: 20,
    language: "ts",
    ...overrides,
  };
}

describe("runSummaryPipeline", () => {
  it("uses ast-index output when available and non-empty (regex/head-tail not called)", async () => {
    const astIndexSummary = mkSummary({
      signals: [{ line: 5, kind: "export", text: "ast" }],
    });
    const astIndex = vi.fn().mockResolvedValue(astIndexSummary);
    const regex = vi.fn();
    const headTail = vi.fn();

    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("summary");
    if (result.kind === "summary") {
      expect(result.summary.signals[0].text).toBe("ast");
    }
    expect(astIndex).toHaveBeenCalledOnce();
    expect(regex).not.toHaveBeenCalled();
    expect(headTail).not.toHaveBeenCalled();
  });

  it("falls to regex when ast-index returns null", async () => {
    const regexSummary = mkSummary({
      signals: [{ line: 3, kind: "import", text: "import x" }],
    });
    const astIndex = vi.fn().mockResolvedValue(null);
    const regex = vi.fn().mockReturnValue(regexSummary);
    const headTail = vi.fn();

    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("summary");
    if (result.kind === "summary") {
      expect(result.summary.signals[0].text).toBe("import x");
    }
    expect(headTail).not.toHaveBeenCalled();
  });

  it("falls from regex to head+tail when regex returns empty signals", async () => {
    const headTailSummary = mkSummary({
      signals: [{ line: 1, kind: "raw", text: "raw line" }],
      note: "head+tail",
    });
    const astIndex = vi.fn().mockResolvedValue(null);
    const regex = vi.fn().mockReturnValue(mkSummary({ signals: [] }));
    const headTail = vi.fn().mockReturnValue(headTailSummary);

    const result = await runSummaryPipeline("src", "x.md", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("summary");
    if (result.kind === "summary") {
      expect(result.summary.note).toBe("head+tail");
    }
  });

  it("falls through to pass-through when head-tail also returns empty signals", async () => {
    const astIndex = vi.fn().mockResolvedValue(null);
    const regex = vi.fn().mockReturnValue(mkSummary({ signals: [] }));
    const headTail = vi.fn().mockReturnValue(mkSummary({ signals: [] }));

    const result = await runSummaryPipeline("", "empty.ts", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("pass-through");
  });

  it("treats ast-index throw as a soft-fail and moves to regex", async () => {
    const astIndex = vi.fn().mockRejectedValue(new Error("subprocess crashed"));
    const regex = vi.fn().mockReturnValue(mkSummary());
    const headTail = vi.fn();

    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("summary");
    expect(regex).toHaveBeenCalledOnce();
    expect(headTail).not.toHaveBeenCalled();
  });

  it("treats regex throw as a soft-fail and moves to head-tail", async () => {
    const astIndex = vi.fn().mockResolvedValue(null);
    const regex = vi.fn().mockImplementation(() => {
      throw new Error("regex exploded");
    });
    const headTail = vi
      .fn()
      .mockReturnValue(
        mkSummary({ signals: [{ line: 1, kind: "raw", text: "x" }] }),
      );

    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("summary");
    expect(headTail).toHaveBeenCalledOnce();
  });

  it("passes through when everything throws", async () => {
    const astIndex = vi.fn().mockRejectedValue(new Error("a"));
    const regex = vi.fn().mockImplementation(() => {
      throw new Error("b");
    });
    const headTail = vi.fn().mockImplementation(() => {
      throw new Error("c");
    });

    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex,
      regex,
      headTail,
    });

    expect(result.kind).toBe("pass-through");
  });

  it("exposes the winning-tier label for observability", async () => {
    const astIndex = vi.fn().mockResolvedValue(mkSummary());
    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex,
      regex: () => mkSummary(),
      headTail: () => mkSummary(),
    });
    if (result.kind === "summary") {
      expect(result.tier).toBe("ast-index");
    }
  });

  it('labels the tier as "regex" when it wins', async () => {
    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex: async () => null,
      regex: () => mkSummary(),
      headTail: () => mkSummary(),
    });
    if (result.kind === "summary") {
      expect(result.tier).toBe("regex");
    }
  });

  it('labels the tier as "head-tail" when it wins', async () => {
    const result = await runSummaryPipeline("src", "x.ts", {
      astIndex: async () => null,
      regex: () => mkSummary({ signals: [] }),
      headTail: () => mkSummary(),
    });
    if (result.kind === "summary") {
      expect(result.tier).toBe("head-tail");
    }
  });
});
