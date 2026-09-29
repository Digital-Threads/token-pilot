/**
 * PreToolUse hook on token-pilot's own MCP tools — keeps relative paths in
 * the checkout the session is actually working in.
 *
 * The MCP server fixes its project root once, when it starts
 * (CLAUDE_PROJECT_DIR). A session that then moves into a git worktree —
 * `cd .worktrees/feature`, the layout superpowers, keel and Claude Code's own
 * worktrees use — kept having relative paths resolved against the main
 * checkout: the same file from another branch, with nothing to say so. It was
 * found on a payment code path during a rebase.
 *
 * Claude Code runs hooks in the session's current directory and applies a
 * PreToolUse `updatedInput` to MCP calls — both verified live on 2.1.281 — so
 * the hook maps relative paths onto the session's checkout before the call
 * reaches the server. Inside the server's own checkout it prints nothing:
 * ordinary sessions see no change at all.
 *
 * Tools that look past a single file — the symbol index, git history and
 * diffs, test runs — still answer from the server's checkout. For those the
 * hook says so, rather than letting the answer pass for the worktree's.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface McpPathInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface McpPathContext {
  /** Root the MCP server resolves relative paths against. */
  projectRoot: string | undefined;
  /** The git checkout a directory belongs to, or null outside any. */
  checkoutOf: (dir: string) => string | null;
}

export type McpPathDecision =
  | { kind: "allow" }
  | { kind: "rewrite"; updatedInput: Record<string, unknown>; note?: string }
  | { kind: "warn"; message: string };

/** Tools that read exactly the file they are handed — right once the path is. */
const FILE_TOOLS = new Set([
  "smart_read",
  "read_symbol",
  "read_symbols",
  "read_range",
  "read_section",
  "read_for_edit",
  "read_diff",
  "smart_read_many",
]);

const OUR_TOOL = /^mcp__(?:plugin_token-pilot_token-pilot|token-pilot)__(.+)$/;

export function decideMcpPath(
  input: McpPathInput,
  ctx: McpPathContext,
): McpPathDecision {
  const tool = OUR_TOOL.exec(input.tool_name ?? "")?.[1];
  const { cwd } = input;
  const { projectRoot } = ctx;
  if (!tool || !cwd || !projectRoot) return { kind: "allow" };

  const serverCheckout = ctx.checkoutOf(projectRoot);
  const sessionCheckout = ctx.checkoutOf(cwd);
  if (!serverCheckout || !sessionCheckout || serverCheckout === sessionCheckout) {
    return { kind: "allow" };
  }

  // The server can be rooted in a sub-project of its checkout; the same
  // sub-project is where relative paths belong in the session's checkout.
  const base = resolve(sessionCheckout, relative(serverCheckout, projectRoot));
  const onBase = (p: unknown): unknown =>
    typeof p === "string" && p !== "" && !isAbsolute(p) ? resolve(base, p) : p;

  // Only `path` and `paths` are filesystem paths. `scope` on find_usages is
  // a prefix filter over index entries and must stay relative.
  const args = input.tool_input ?? {};
  const updatedInput: Record<string, unknown> = { ...args };
  let changed = false;

  if ("path" in args && onBase(args.path) !== args.path) {
    updatedInput.path = onBase(args.path);
    changed = true;
  }

  if (Array.isArray(args.paths)) {
    const mapped = args.paths.map(onBase);
    if (mapped.some((p, i) => p !== (args.paths as unknown[])[i])) {
      updatedInput.paths = mapped;
      changed = true;
    }
  }

  const note = FILE_TOOLS.has(tool)
    ? undefined
    : `[token-pilot] This session works in ${sessionCheckout}, but token-pilot's ` +
      `symbol index, git context and test runs are rooted at ${serverCheckout}. ` +
      `${tool} answers from ${serverCheckout} — possibly another branch. Files ` +
      `in this checkout read correctly by path (smart_read, read_symbol).`;

  if (changed) return { kind: "rewrite", updatedInput, note };
  if (note) return { kind: "warn", message: note };

  return { kind: "allow" };
}

/**
 * Claude Code applies `updatedInput` only together with a permission
 * decision. `allow` also skips the approval prompt — acceptable here because
 * the rewrite fires only for token-pilot's own read-only tools, and only when
 * the session is in a different checkout from the server.
 */
export function renderMcpPathOutput(decision: McpPathDecision): string | null {
  if (decision.kind === "allow") return null;

  if (decision.kind === "warn") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: decision.message,
      },
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: decision.updatedInput,
      ...(decision.note ? { additionalContext: decision.note } : {}),
    },
  });
}

/**
 * The git checkout `dir` belongs to: the nearest ancestor holding a `.git`
 * entry — a directory for the main checkout, a file for a linked worktree,
 * which is exactly the distinction this hook needs.
 */
export function findCheckout(dir: string): string | null {
  let current = resolve(dir);

  for (;;) {
    if (existsSync(join(current, ".git"))) return current;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
