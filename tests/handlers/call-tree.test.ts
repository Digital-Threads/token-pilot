/**
 * Tests for the call_tree handler.
 *
 * Handler is a thin wrapper over AstIndexClient.callTree — we stub the
 * client and assert on the rendered text, depth clamping, and failure
 * paths (disabled index / missing symbol / null response).
 */
import { describe, expect, it } from "vitest";
import { handleCallTree } from "../../src/handlers/call-tree.ts";
import type { AstIndexClient } from "../../src/ast-index/client.ts";
import type { AstIndexCallTreeNode } from "../../src/ast-index/types.ts";

function makeStub(
  overrides: Partial<{
    disabled: boolean;
    oversized: boolean;
    tree: AstIndexCallTreeNode | null;
    callTreeSpy: (sym: string, d: number) => void;
  }> = {},
): AstIndexClient {
  return {
    isDisabled: () => overrides.disabled ?? false,
    isOversized: () => overrides.oversized ?? false,
    callTree: async (sym: string, d: number) => {
      overrides.callTreeSpy?.(sym, d);
      return overrides.tree ?? null;
    },
  } as unknown as AstIndexClient;
}

describe("handleCallTree", () => {
  it("renders a simple 2-level tree with file:line locations", async () => {
    const tree: AstIndexCallTreeNode = {
      name: "fetchUser",
      file: "src/api.ts",
      line: 42,
      callers: [
        {
          name: "getProfile",
          file: "src/profile.ts",
          line: 10,
          callers: [{ name: "handleRequest", file: "src/router.ts", line: 7 }],
        },
      ],
    };
    const out = await handleCallTree(
      { symbol: "fetchUser" },
      makeStub({ tree }),
    );
    const text = out.content[0].text;
    expect(text).toContain("CALL TREE for `fetchUser`");
    expect(text).toContain("fetchUser — src/api.ts:42");
    expect(text).toContain("getProfile — src/profile.ts:10");
    expect(text).toContain("handleRequest — src/router.ts:7");
    // meta.files aggregates every file in the tree
    expect(out.meta.files).toEqual(
      expect.arrayContaining(["src/api.ts", "src/profile.ts", "src/router.ts"]),
    );
  });

  it("clamps depth between 1 and 6", async () => {
    let captured = 0;
    const stub = makeStub({
      tree: { name: "x" },
      callTreeSpy: (_s, d) => (captured = d),
    });
    await handleCallTree({ symbol: "x", depth: 100 }, stub);
    expect(captured).toBe(6);
    await handleCallTree({ symbol: "x", depth: 0 }, stub);
    expect(captured).toBe(1);
    await handleCallTree({ symbol: "x", depth: 3.7 }, stub);
    expect(captured).toBe(3);
  });

  it("defaults depth to 3 when omitted", async () => {
    let captured = 0;
    const stub = makeStub({
      tree: { name: "x" },
      callTreeSpy: (_s, d) => (captured = d),
    });
    await handleCallTree({ symbol: "x" }, stub);
    expect(captured).toBe(3);
  });

  it("returns a graceful message when symbol is missing", async () => {
    const out = await handleCallTree(
      { symbol: "" as string },
      makeStub({ tree: null }),
    );
    expect(out.content[0].text).toMatch(/required/i);
    expect(out.meta.files).toEqual([]);
  });

  it("returns a graceful message when call-tree returns null", async () => {
    const out = await handleCallTree(
      { symbol: "nope" },
      makeStub({ tree: null }),
    );
    expect(out.content[0].text).toMatch(/No call-tree found/);
    expect(out.content[0].text).toContain("nope");
    expect(out.content[0].text).toMatch(/find_usages/);
  });

  it("surfaces a disabled-index hint", async () => {
    const out = await handleCallTree(
      { symbol: "x" },
      makeStub({ disabled: true }),
    );
    expect(out.content[0].text).toMatch(/disabled/i);
    expect(out.content[0].text).toMatch(/smart_read/);
  });

  it("surfaces an oversized-index hint", async () => {
    const out = await handleCallTree(
      { symbol: "x" },
      makeStub({ oversized: true }),
    );
    expect(out.content[0].text).toMatch(/disabled/i);
    expect(out.content[0].text).toMatch(/node_modules/);
  });
});
