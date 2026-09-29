/**
 * The MCP server fixes its project root once, at start-up. When the session
 * then moves into a git worktree (`cd .worktrees/x`), a relative path handed
 * to token-pilot still resolved against the main checkout — so the model was
 * shown the same file from another branch, with nothing to say so.
 *
 * Claude Code runs hooks in the session's current directory and applies a
 * PreToolUse `updatedInput` to MCP calls (both verified live on 2.1.281), so
 * the hook resolves relative paths against the checkout the session is in.
 */
import { describe, it, expect } from "vitest";
import {
  decideMcpPath,
  renderMcpPathOutput,
} from "../../src/hooks/mcp-path.ts";

const MAIN = "/repo";
const WT = "/repo/.worktrees/feature";
const SIBLING = "/work/repo-feature";

// Checkout lookup stub: which git checkout a directory belongs to.
const checkoutOf = (dir: string): string | null => {
  if (dir.startsWith(WT)) return WT;
  if (dir.startsWith(SIBLING)) return SIBLING;
  if (dir.startsWith(MAIN)) return MAIN;
  return null;
};

const ctx = { projectRoot: MAIN, checkoutOf };
const call = (tool: string, toolInput: Record<string, unknown>, cwd: string) =>
  decideMcpPath(
    {
      tool_name: `mcp__plugin_token-pilot_token-pilot__${tool}`,
      tool_input: toolInput,
      cwd,
    },
    ctx,
  );

describe("decideMcpPath — same checkout", () => {
  it("changes nothing when the session is where the server is", () => {
    expect(call("smart_read", { path: "src/a.ts" }, MAIN).kind).toBe("allow");
    expect(call("smart_read", { path: "src/a.ts" }, `${MAIN}/src`).kind).toBe(
      "allow",
    );
  });

  it("changes nothing without a cwd or a project root", () => {
    expect(
      decideMcpPath(
        { tool_name: "mcp__token-pilot__smart_read", tool_input: { path: "a.ts" } },
        ctx,
      ).kind,
    ).toBe("allow");
    expect(
      decideMcpPath(
        {
          tool_name: "mcp__token-pilot__smart_read",
          tool_input: { path: "a.ts" },
          cwd: WT,
        },
        { projectRoot: undefined, checkoutOf },
      ).kind,
    ).toBe("allow");
  });
});

describe("decideMcpPath — session inside another worktree", () => {
  it("resolves a relative path against the worktree the session is in", () => {
    const d = call("read_symbol", { path: "src/a.ts", symbol: "f" }, WT);

    expect(d.kind).toBe("rewrite");
    if (d.kind === "rewrite") {
      expect(d.updatedInput).toEqual({ path: `${WT}/src/a.ts`, symbol: "f" });
    }
  });

  it("also works for a sibling worktree outside the main checkout", () => {
    const d = call("smart_read", { path: "src/a.ts" }, `${SIBLING}/src`);

    expect(d.kind).toBe("rewrite");
    if (d.kind === "rewrite") {
      expect(d.updatedInput.path).toBe(`${SIBLING}/src/a.ts`);
    }
  });

  it("rewrites every relative entry of smart_read_many", () => {
    const d = call(
      "smart_read_many",
      { paths: ["a.ts", `${WT}/b.ts`, "lib/c.ts"] },
      WT,
    );

    expect(d.kind).toBe("rewrite");
    if (d.kind === "rewrite") {
      expect(d.updatedInput.paths).toEqual([
        `${WT}/a.ts`,
        `${WT}/b.ts`,
        `${WT}/lib/c.ts`,
      ]);
    }
  });

  it("leaves absolute paths alone", () => {
    expect(call("smart_read", { path: `${WT}/a.ts` }, WT).kind).toBe("allow");
  });

  it("keeps the server's position inside its checkout", () => {
    // Server rooted at a sub-project; the same sub-project in the worktree.
    const d = decideMcpPath(
      {
        tool_name: "mcp__token-pilot__smart_read",
        tool_input: { path: "a.ts" },
        cwd: WT,
      },
      { projectRoot: `${MAIN}/packages/api`, checkoutOf },
    );

    expect(d.kind).toBe("rewrite");
    if (d.kind === "rewrite") {
      expect(d.updatedInput.path).toBe(`${WT}/packages/api/a.ts`);
    }
  });

  it("does not touch find_usages scope — it is an index prefix, not a path", () => {
    const d = call("find_usages", { symbol: "f", scope: "src/Domain/" }, WT);

    expect(d.kind).toBe("warn");
    expect(JSON.stringify(d)).not.toContain(`${WT}/src/Domain`);
  });

  it("warns on whole-tree tools, which still answer from the main checkout", () => {
    const d = call("project_overview", {}, WT);

    expect(d.kind).toBe("warn");
    if (d.kind === "warn") {
      expect(d.message).toContain(WT);
      expect(d.message).toContain(MAIN);
    }
  });

  it("rewrites and warns together for a path tool that runs git", () => {
    const d = call("smart_log", { path: "src/a.ts" }, WT);

    expect(d.kind).toBe("rewrite");
    if (d.kind === "rewrite") {
      expect(d.updatedInput.path).toBe(`${WT}/src/a.ts`);
      expect(d.note).toBeTruthy();
    }
  });

  it("ignores tools that are not ours", () => {
    expect(
      decideMcpPath(
        { tool_name: "mcp__other__read", tool_input: { path: "a.ts" }, cwd: WT },
        ctx,
      ).kind,
    ).toBe("allow");
  });
});

describe("renderMcpPathOutput", () => {
  it("emits nothing for allow", () => {
    expect(renderMcpPathOutput({ kind: "allow" })).toBeNull();
  });

  it("emits updatedInput with an explicit allow", () => {
    const out = JSON.parse(
      renderMcpPathOutput({ kind: "rewrite", updatedInput: { path: "/x" } })!,
    );

    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { path: "/x" },
    });
  });

  it("carries a warning as additionalContext without deciding", () => {
    const out = JSON.parse(
      renderMcpPathOutput({ kind: "warn", message: "heads up" })!,
    );

    expect(out.hookSpecificOutput.additionalContext).toBe("heads up");
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });
});

describe("findCheckout", () => {
  it("stops at a linked worktree, not at the main checkout around it", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { findCheckout } = await import("../../src/hooks/mcp-path.ts");

    const root = await mkdtemp(join(tmpdir(), "tp-checkout-"));
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".worktrees", "wt", "src"), { recursive: true });
      await writeFile(join(root, ".worktrees", "wt", ".git"), "gitdir: x\n");

      expect(findCheckout(join(root, "src"))).toBe(root);
      expect(findCheckout(join(root, ".worktrees", "wt", "src"))).toBe(
        join(root, ".worktrees", "wt"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
