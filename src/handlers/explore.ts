import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AstIndexClient } from "../ast-index/client.js";
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
  const symbols = raw.symbols.filter((s) => s.kind !== "import");
  const neighbours = await realNeighbours(raw.neighbours, symbols, projectRoot);
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

  // Source — file heads (source is already line-numbered)
  if (result.files.length > 0) {
    lines.push("");
    lines.push("## Source");
    for (const f of result.files) {
      lines.push(`${f.path}:${f.line}`);
      lines.push("```");
      lines.push(f.source.replace(/\n+$/, ""));
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
    hidden === 0;

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
 * Graph neighbours worth showing. ast-index's "caller" is the nearest named
 * symbol above a call site — a nested helper declared earlier in the same
 * function, a constant in a test file — and a function calling an
 * unrelated same-named method (`xs.find(…)` for a `find` function). A
 * caller stays only when its own body references a ranked symbol; a
 * member access (`.name`) counts only for method/property targets.
 */
async function realNeighbours(
  neighbours: AstIndexExploreNeighbour[],
  symbols: AstIndexExploreSymbol[],
  projectRoot: string,
): Promise<AstIndexExploreNeighbour[]> {
  const targets = symbols.filter((s) => !s.vendor);
  const cache = new Map<string, string[] | null>();
  const out: AstIndexExploreNeighbour[] = [];

  for (const n of neighbours) {
    if (n.kind === "import") continue;
    if (n.link !== "caller") {
      out.push(n);
      continue;
    }
    if (!cache.has(n.path)) {
      cache.set(
        n.path,
        await readFile(resolve(projectRoot, n.path), "utf-8").then(
          (t) => t.split("\n"),
          () => null,
        ),
      );
    }
    const lines = cache.get(n.path);
    // its own declaration is not a reference
    const others = targets.filter((t) => t.name !== n.name);
    if (lines && referencesAny(blockAt(lines, n.line), others)) out.push(n);
  }

  return out;
}

/** The declaration at `line` (1-based) through the line that closes it by indentation. */
function blockAt(lines: string[], line: number): string {
  const indent = (s: string) => s.length - s.trimStart().length;
  const start = Math.max(0, line - 1);
  const base = indent(lines[start] ?? "");
  const body = [lines[start] ?? ""];

  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "" && indent(l) <= base) {
      if (/^\s*[}\])]/.test(l)) body.push(l);
      break;
    }
    body.push(l);
  }

  return body.join("\n");
}

function referencesAny(block: string, targets: AstIndexExploreSymbol[]): boolean {
  return targets.some((t) => {
    const name = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const member = t.kind === "method" || t.kind === "property";
    const before = member ? "(^|[^\\w$])" : "(^|[^\\w$.])";
    return new RegExp(`${before}${name}(?![\\w$])`).test(block);
  });
}
