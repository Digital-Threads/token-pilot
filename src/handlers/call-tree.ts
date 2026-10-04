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
import { formatConfidence } from "../core/confidence.js";

export interface CallTreeArgs {
  /** Function / method name (unqualified, e.g. `fetchUser`). */
  symbol: string;
  /** Walk-up depth. Default 3, max 6 (anything deeper is overwhelming). */
  depth?: number;
}

const MAX_DEPTH = 6;

/** Callers per level asked from ast-index (its own default). */
const PER_LEVEL = 10;

const GREP_BASED =
  "callers are matched by name: calls from anonymous callbacks or top-level code are not attributed, and a same-named function elsewhere can appear";

/** Renders the subtree; true when any level in it hit the per-level cap. */
function renderNode(
  node: AstIndexCallTreeNode,
  indent: string,
  out: string[],
): boolean {
  if (node.recursive) {
    out.push(`${indent}${node.name} (recursive, shown above)`);
    return false;
  }

  const loc =
    node.file && node.line != null
      ? ` — ${node.file}:${node.line}`
      : node.file
        ? ` — ${node.file}`
        : "";
  const cap = node.capped ? `  [first ${PER_LEVEL} callers only]` : "";
  out.push(`${indent}${node.name}${loc}${cap}`);

  let capped = !!node.capped;
  for (const child of node.callers ?? []) {
    capped = renderNode(child, indent + "  ", out) || capped;
  }

  return capped;
}

/** A bare root: say whether the symbol exists and what call-tree cannot see. */
async function noCallers(
  symbol: string,
  astIndex: AstIndexClient,
  dropped = 0,
): Promise<string> {
  const refs = await astIndex.refs(symbol, 50);
  const defs = refs.definitions.filter((d) => !d.name || d.name === symbol);
  const uses = refs.usages.length;
  const lines: string[] = [];

  if (dropped > 0) {
    lines.push(
      `No verified callers for \`${symbol}\`: ast-index named ${dropped}, but none of them references it in its own body (a mention in a comment, call-like text, or a same-named symbol elsewhere). Run find_usages("${symbol}") for every call site.`,
    );
  } else if (defs.length === 0 && uses === 0) {
    lines.push(
      `\`${symbol}\` was not found in the index — check the spelling; files under dot-directories (e.g. .github/) are not indexed.`,
    );
  } else {
    lines.push(`No callers found for \`${symbol}\` by ast-index call-tree.`);
    lines.push(
      uses > 0
        ? `${uses >= 50 ? "50+" : uses} references exist, though: call-tree only attributes calls made inside a named function, so calls from anonymous callbacks, top-level code and test blocks are missed. Run find_usages("${symbol}") for the full list.`
        : `find_usages("${symbol}") finds no references either.`,
    );
  }
  lines.push(
    formatConfidence({
      confidence: "low",
      knownUnknowns: astIndex.isStale?.() ? [GREP_BASED, "index may be stale"] : [GREP_BASED],
    }),
  );

  return lines.join("\n");
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

  const tree = await astIndex.callTree(symbol, depth, PER_LEVEL);
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

  if (!tree.callers?.length) {
    return {
      content: [{ type: "text", text: await noCallers(symbol, astIndex, tree.dropped) }],
      meta: { files: [] },
    };
  }

  const lines: string[] = [];
  lines.push(
    `CALL TREE for \`${symbol}\` (depth ${depth}, callers of callers…):`,
  );
  lines.push("");
  const capped = renderNode(tree, "  ", lines);
  lines.push("");
  lines.push(
    "Read bottom-up: indented entries call the parent. Root is the symbol you asked for.",
  );
  if (tree.dropped) {
    lines.push(
      `${tree.dropped} call sites not shown: ast-index attributed them to call-like text (a constructor, a string, a comment) or to a function whose body does not reference the callee. find_usages("${symbol}") lists every call site.`,
    );
  }
  const stale = astIndex.isStale?.() ?? false;
  lines.push(
    formatConfidence({
      confidence: capped || stale ? "low" : "medium",
      knownUnknowns: (stale ? ["index may be stale — recent edits may be missing"] : []).concat(capped
        ? [
            `at most ${PER_LEVEL} callers per level are shown — levels marked [first ${PER_LEVEL} callers only] have more; use find_usages for the full list`,
            GREP_BASED,
          ]
        : [GREP_BASED]),
    }),
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
