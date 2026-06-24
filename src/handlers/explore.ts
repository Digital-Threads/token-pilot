import type { AstIndexClient } from "../ast-index/client.js";
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
  void projectRoot; // explore runs against the index root, not a path
  const result = await astIndex.explore(args.query, {
    maxFiles: args.max_files,
    graph: args.graph,
  });

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
    result.tests.length === 0;

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
