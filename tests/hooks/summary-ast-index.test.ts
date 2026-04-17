import { describe, it, expect, vi } from "vitest";
import { parseAstIndexSummary } from "../../src/hooks/summary-ast-index.js";

describe("parseAstIndexSummary", () => {
  it("returns null when binary is not available (binaryPath=null)", async () => {
    const summary = await parseAstIndexSummary("x", "foo.ts", {
      binaryPath: null,
    });
    expect(summary).toBeNull();
  });

  it("maps outline entries to signals with start_line and kind", async () => {
    const fakeOutline = `:10 greet [function]
:20 Greeter [class]
  :22 greet [method]
:40 Handler [interface]`;

    const exec = vi.fn().mockResolvedValue({ stdout: fakeOutline, stderr: "" });
    const summary = await parseAstIndexSummary("src", "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
    });

    expect(summary).not.toBeNull();
    expect(summary!.signals.length).toBeGreaterThanOrEqual(3);

    const lines = summary!.signals.map((s) => s.line);
    expect(lines).toContain(10);
    expect(lines).toContain(20);

    // Binary was invoked with outline + filePath
    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/ast-index",
      ["outline", "x.ts"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("returns null when the subprocess rejects (e.g. timeout or non-zero exit)", async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
      );
    const summary = await parseAstIndexSummary("src", "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
    });
    expect(summary).toBeNull();
  });

  it("returns null when parseOutlineText finds no entries (empty stdout)", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const summary = await parseAstIndexSummary("src", "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
    });
    expect(summary).toBeNull();
  });

  it("flattens nested children into the signals list", async () => {
    const fakeOutline = `:1 Outer [class]
  :5 inner_a [method]
  :12 inner_b [method]
  :20 Nested [class]
    :22 deep [method]`;

    const exec = vi.fn().mockResolvedValue({ stdout: fakeOutline, stderr: "" });
    const summary = await parseAstIndexSummary("src", "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
    });

    expect(summary).not.toBeNull();
    const texts = summary!.signals.map((s) => s.text).join(" | ");
    expect(texts).toContain("inner_a");
    expect(texts).toContain("inner_b");
    expect(texts).toContain("deep");
  });

  it("populates totalLines and estimatedTokens from the source content", async () => {
    const content = "abc\n".repeat(100);
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: ":1 foo [function]", stderr: "" });
    const summary = await parseAstIndexSummary(content, "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
    });

    expect(summary).not.toBeNull();
    expect(summary!.totalLines).toBe(content.split("\n").length);
    expect(summary!.estimatedTokens).toBeGreaterThan(0);
    expect(summary!.language).toBe("ts");
  });

  it("respects a caller-provided timeout", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: ":1 f [function]", stderr: "" });
    await parseAstIndexSummary("src", "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
      timeoutMs: 1234,
    });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 1234 }),
    );
  });

  it("truncates excessively long signal text", async () => {
    const longName = "x".repeat(500);
    const fakeOutline = `:1 ${longName} [function]`;
    const exec = vi.fn().mockResolvedValue({ stdout: fakeOutline, stderr: "" });
    const summary = await parseAstIndexSummary("src", "x.ts", {
      binaryPath: "/usr/local/bin/ast-index",
      exec,
    });
    expect(summary).not.toBeNull();
    expect(summary!.signals[0].text.length).toBeLessThanOrEqual(140);
  });
});
