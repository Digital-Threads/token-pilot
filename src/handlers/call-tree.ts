/**
 * v0.32.0 — call_tree MCP tool.
 *
 * Thin wrapper over `AstIndexClient.callTree`. Produces a text tree of
 * callers (depth-N) for one function. Complements `find_usages` which
 * is flat (one level of refs): call_tree is recursive, so you see the
 * full chain from leaves → entry points.
 *
 * Typical use cases:
 *   - debugging: "who eventually calls this helper"
 *   - refactor planning: "what breaks if I change this function's
 *     signature"
 *   - dead-code verification: "does anything actually reach this
 *     branch"
 *
 * Output shape is indented tree text, not JSON — the MCP-consuming
 * model needs to read it, not diff it.
 */
import type { AstIndexClient } from "../ast-index/client.js";
import type { AstIndexCallTreeNode } from "../ast-index/types.js";

export interface CallTreeArgs {
  /** Function / method name (unqualified, e.g. `fetchUser`). */
  symbol: string;
  /** Walk-up depth. Default 3, max 6 (anything deeper is overwhelming). */
  depth?: number;
}

const MAX_DEPTH = 6;

function renderNode(
  node: AstIndexCallTreeNode,
  indent: string,
  out: string[],
): void {
  const loc =
    node.file && node.line != null
      ? ` — ${node.file}:${node.line}`
      : node.file
        ? ` — ${node.file}`
        : "";
  out.push(`${indent}${node.name}${loc}`);
  if (node.callers && node.callers.length > 0) {
    for (const child of node.callers) {
      renderNode(child, indent + "  ", out);
    }
  }
}

export async function handleCallTree(
  args: CallTreeArgs,
  astIndex: AstIndexClient,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  meta: { files: string[] };
}> {
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [
        {
          type: "text",
          text:
            "call_tree is disabled: " +
            (astIndex.isDisabled()
              ? "project root not detected. Call smart_read() on any project file first."
              : "ast-index indexed >50k files (likely includes node_modules). Ensure node_modules is in .gitignore.") +
            "\nAlternative: use find_usages(symbol) iteratively.",
        },
      ],
      meta: { files: [] },
    };
  }

  const symbol = args.symbol?.trim();
  if (!symbol) {
    return {
      content: [{ type: "text", text: "call_tree: `symbol` is required." }],
      meta: { files: [] },
    };
  }

  const depth = Math.min(Math.max(1, Math.floor(args.depth ?? 3)), MAX_DEPTH);

  const tree = await astIndex.callTree(symbol, depth);
  if (!tree) {
    return {
      content: [
        {
          type: "text",
          text: `No call-tree found for \`${symbol}\`. The symbol may be uncalled, unindexed, or ambiguous. Try find_usages("${symbol}") for a flat cross-reference list.`,
        },
      ],
      meta: { files: [] },
    };
  }

  const lines: string[] = [];
  lines.push(
    `CALL TREE for \`${symbol}\` (depth ${depth}, callers of callers…):`,
  );
  lines.push("");
  renderNode(tree, "  ", lines);
  lines.push("");
  lines.push(
    "Read bottom-up: indented entries call the parent. Root is the symbol you asked for.",
  );

  // Collect files for meta so downstream consumers can open them.
  const files = new Set<string>();
  const collect = (n: AstIndexCallTreeNode): void => {
    if (n.file) files.add(n.file);
    n.callers?.forEach(collect);
  };
  collect(tree);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    meta: { files: [...files] },
  };
}
