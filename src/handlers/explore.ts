import type { AstIndexClient } from "../ast-index/client.js";
import { blockAt, codeLines, mentions } from "../ast-index/references.js";
import type { AstIndexExploreNeighbour, AstIndexExploreSymbol } from "../ast-index/types.js";
import type { ExploreArgs } from "../core/validation.js";

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MAX_RANKED_SYMBOLS = 12;

export interface ExploreMeta {
  query: string;
  symbolCount: number;
  fileCount: number;
  neighbourCount: number;
  testCount: number;
}

// ──────────────────────────────────────────────
// Handler — one-shot ranked context + graph blast-radius.
// Mirrors the shape of handleExploreArea: build a compact, token-efficient
// text block and return it with lightweight meta.
// ──────────────────────────────────────────────

export async function handleExplore(
  args: ExploreArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  meta: ExploreMeta;
}> {
  const raw = await astIndex.explore(args.query, {
    maxFiles: args.max_files,
    graph: args.graph,
  });
  // Import statements are not symbols; tests groups without tests say nothing.
  const ranked = raw.symbols.filter((s) => s.kind !== "import");
  const files = new Map<string, Promise<string[] | null>>();
  const linesOf = (path: string): Promise<string[] | null> => {
    if (!files.has(path)) files.set(path, codeLines(projectRoot, path));
    return files.get(path)!;
  };
  const symbols = await relevantSymbols(ranked, raw.query || args.query, linesOf);
  const hiddenSymbols = ranked.length - symbols.length;
  const neighbours = await realNeighbours(raw.neighbours, symbols, linesOf);
  const hidden = raw.neighbours.length - neighbours.length;
  const result = {
    ...raw,
    symbols,
    neighbours,
    tests: raw.tests.filter((t) => t.tests.length > 0),
  };

  const lines: string[] = [];
  lines.push(
    `# explore: "${result.query}"  (lang: ${result.dominantLanguage || "?"})`,
  );

  // Ranked symbols
  if (result.symbols.length > 0) {
    lines.push("");
    lines.push("## Ranked symbols");
    for (const s of result.symbols.slice(0, MAX_RANKED_SYMBOLS)) {
      const vendorTag = s.vendor ? " [vendor]" : "";
      lines.push(
        `${Math.round(s.score)}  ${s.kind} ${s.name}  ${s.path}:${s.line}${vendorTag}`,
      );
    }
  }

  // Source — file heads (source is already line-numbered); for a class or
  // module hit ast-index ≥3.56 sends the file's outline instead.
  if (result.files.length > 0) {
    lines.push("");
    lines.push("## Source");
    for (const f of result.files) {
      lines.push(`${f.path}:${f.line}`);
      lines.push("```");
      if (f.source !== undefined) lines.push(f.source.replace(/\n+$/, ""));
      for (const o of f.outline ?? []) {
        const span = o.end_line > o.line ? `${o.line}-${o.end_line}` : `${o.line}`;
        lines.push(`${o.line === f.line ? "→" : " "} :${span} ${o.name} [${o.kind}]`);
      }
      if (f.outlineHidden) lines.push(`  … ${f.outlineHidden} more`);
      lines.push("```");
    }
  }

  // Graph neighbours (blast radius) — only with --rwr
  if (result.neighbours.length > 0) {
    lines.push("");
    lines.push("## Graph neighbours (blast radius)");
    for (const n of result.neighbours) {
      lines.push(`${n.link}  ${n.kind} ${n.name}  ${n.path}:${n.line}`);
    }
  }
  if (hiddenSymbols > 0) {
    lines.push("");
    lines.push(
      `${hiddenSymbols} ranked symbols not shown: their names do not match the query and their bodies do not reference a symbol that does (ast-index also ranks the nearest symbol above a call site).`,
    );
  }
  if (hidden > 0) {
    lines.push("");
    lines.push(
      `${hidden} graph neighbours not shown: import statements, or "callers" whose body does not reference a ranked symbol (ast-index names the nearest symbol above a call site). find_usages lists every call site.`,
    );
  }

  // Tests grouped by source
  if (result.tests.length > 0) {
    lines.push("");
    lines.push("## Tests");
    for (const t of result.tests) {
      lines.push(`${t.source}:`);
      for (const test of t.tests) {
        lines.push(`  ${test}`);
      }
    }
  }

  const empty =
    result.symbols.length === 0 &&
    result.files.length === 0 &&
    result.neighbours.length === 0 &&
    result.tests.length === 0 &&
    hidden === 0 &&
    hiddenSymbols === 0;

  if (empty) {
    const reason =
      result.error ?? "No results — index unavailable or query matched nothing.";
    return {
      content: [
        {
          type: "text",
          text: `# explore: "${result.query}"\n\n${reason}`,
        },
      ],
      meta: {
        query: result.query,
        symbolCount: 0,
        fileCount: 0,
        neighbourCount: 0,
        testCount: 0,
      },
    };
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    meta: {
      query: result.query,
      symbolCount: result.symbols.length,
      fileCount: result.files.length,
      neighbourCount: result.neighbours.length,
      testCount: result.tests.reduce((n, t) => n + t.tests.length, 0),
    },
  };
}

// ──────────────────────────────────────────────
// Blast-radius check
// ──────────────────────────────────────────────

/**
 * Ranked symbols worth showing. Next to the query's own hits ast-index ranks
 * graph callers, named after the nearest symbol above a call site — often a
 * nested helper that never calls the hit. A symbol whose name does not match
 * the query stays only when its own body (comments aside) references one
 * that does. Without any name match there is nothing to check against.
 */
async function relevantSymbols(
  symbols: AstIndexExploreSymbol[],
  query: string,
  linesOf: (path: string) => Promise<string[] | null>,
): Promise<AstIndexExploreSymbol[]> {
  const words = query.toLowerCase().split(/[^\w$]+/).filter((w) => w.length >= 3);
  const isHit = (s: AstIndexExploreSymbol) => words.some((w) => s.name.toLowerCase().includes(w));
  const hits = symbols.filter((s) => isHit(s) && !s.vendor);
  if (hits.length === 0) return symbols;
  const out: AstIndexExploreSymbol[] = [];

  for (const s of symbols) {
    const lines = isHit(s) ? null : await linesOf(s.path);
    if (isHit(s) || (lines && referencesAny(blockAt(lines, s.line), hits))) out.push(s);
  }

  return out;
}

/**
 * Graph neighbours worth showing. ast-index's "caller" is the nearest named
 * symbol above a call site — a nested helper declared earlier in the same
 * function, a constant in a test file — and a function calling an
 * unrelated same-named method (`xs.find(…)` for a `find` function). A
 * caller stays only when its own body references a ranked symbol outside
 * comments; a member access (`.name`) counts only for method/property targets.
 */
async function realNeighbours(
  neighbours: AstIndexExploreNeighbour[],
  symbols: AstIndexExploreSymbol[],
  linesOf: (path: string) => Promise<string[] | null>,
): Promise<AstIndexExploreNeighbour[]> {
  const targets = symbols.filter((s) => !s.vendor);
  const out: AstIndexExploreNeighbour[] = [];

  for (const n of neighbours) {
    if (n.kind === "import") continue;
    if (n.link !== "caller") {
      out.push(n);
      continue;
    }
    const lines = await linesOf(n.path);
    // its own declaration is not a reference
    const others = targets.filter((t) => t.name !== n.name);
    if (lines && referencesAny(blockAt(lines, n.line), others)) out.push(n);
  }

  return out;
}

function referencesAny(block: string, targets: AstIndexExploreSymbol[]): boolean {
  return targets.some((t) => mentions(block, t.name, t.kind === "method" || t.kind === "property"));
}
