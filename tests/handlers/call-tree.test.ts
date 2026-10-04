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
    refs: { definitions: unknown[]; imports: unknown[]; usages: unknown[] };
  }> = {},
): AstIndexClient {
  return {
    isDisabled: () => overrides.disabled ?? false,
    isOversized: () => overrides.oversized ?? false,
    callTree: async (sym: string, d: number) => {
      overrides.callTreeSpy?.(sym, d);
      return overrides.tree ?? null;
    },
    refs: async () =>
      overrides.refs ?? { definitions: [], imports: [], usages: [] },
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

  it("says no callers were found and points at the references the tree cannot attribute", async () => {
    const out = await handleCallTree(
      { symbol: "handleFindUsages" },
      makeStub({
        tree: { name: "handleFindUsages", callers: [] },
        refs: {
          definitions: [{ path: "src/handlers/find-usages.ts", line: 152 }],
          imports: [],
          usages: [
            { path: "src/server.ts", line: 833 },
            { path: "tests/handlers/find-usages.test.ts", line: 23 },
          ],
        },
      }),
    );
    const text = out.content[0].text;
    expect(text).toMatch(/No callers found/);
    expect(text).toMatch(/2 references/);
    expect(text).toMatch(/find_usages\("handleFindUsages"\)/);
    expect(text).toMatch(/CONFIDENCE: low/);
  });

  it("says the symbol is not in the index when the bare root has no definition either", async () => {
    const out = await handleCallTree(
      { symbol: "noSuchFn" },
      makeStub({ tree: { name: "noSuchFn", callers: [] } }),
    );
    expect(out.content[0].text).toMatch(/not found in the index/);
  });

  it("marks a level that hit the per-level cap and lowers confidence", async () => {
    const callers = Array.from({ length: 10 }, (_, i) => ({
      name: `c${i}`,
      file: "src/a.ts",
      line: i + 1,
      callers: [],
    }));
    const out = await handleCallTree(
      { symbol: "x" },
      makeStub({ tree: { name: "x", capped: true, callers } }),
    );
    const text = out.content[0].text;
    expect(text).toMatch(/x .*first 10 callers only/);
    expect(text).toMatch(/CONFIDENCE: low/);
    expect(text).toMatch(/KNOWN UNKNOWNS: .*10 callers per level/);
  });

  it("says when the index may be stale and lowers confidence", async () => {
    const stub = makeStub({
      tree: { name: "x", callers: [{ name: "a", file: "src/a.ts", line: 1, callers: [] }] },
    }) as any;
    stub.isStale = () => true;
    const text = (await handleCallTree({ symbol: "x" }, stub)).content[0].text;

    expect(text).toMatch(/CONFIDENCE: low/);
    expect(text).toMatch(/index may be stale/);
  });

  it("says how many grep artefacts were dropped from the tree", async () => {
    const out = await handleCallTree(
      { symbol: "x" },
      makeStub({
        tree: {
          name: "x",
          dropped: 3,
          callers: [{ name: "a", file: "src/a.ts", line: 1, callers: [] }],
        },
      }),
    );
    expect(out.content[0].text).toMatch(/3 call sites not shown/);
  });

  it("marks recursive entries instead of printing them as plain callers", async () => {
    const out = await handleCallTree(
      { symbol: "x" },
      makeStub({
        tree: {
          name: "x",
          callers: [
            { name: "a", file: "src/a.ts", line: 1, callers: [{ name: "a", recursive: true }] },
          ],
        },
      }),
    );
    expect(out.content[0].text).toContain("a (recursive, shown above)");
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
