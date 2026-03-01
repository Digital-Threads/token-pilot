import type { AstIndexClient } from '../ast-index/client.js';

export interface SearchCodeArgs {
  query: string;
  in_file?: string;
  max_results?: number;
  fuzzy?: boolean;
}

export async function handleSearchCode(
  args: SearchCodeArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const results = await astIndex.search(args.query, {
    inFile: args.in_file,
    maxResults: args.max_results ?? 20,
    fuzzy: args.fuzzy,
  });

  if (results.length === 0) {
    const hints = [`No results found for "${args.query}".`];
    if (!args.fuzzy) hints.push('TIP: Try fuzzy=true for broader matching.');
    if (!astIndex.isAvailable()) {
      hints.push('WARNING: ast-index is not available. Install it: cargo install ast-index');
    } else {
      hints.push('TIP: Index may not cover this language/project. Run `ast-index build` in the project root.');
      hints.push('TIP: Check that the symbol exists and the index is up to date (project_overview shows index status).');
    }
    return { content: [{ type: 'text', text: hints.join('\n') }] };
  }

  const lines: string[] = [
    `SEARCH: "${args.query}" (${results.length} results)`,
    '',
  ];

  for (const r of results) {
    lines.push(`  ${r.file}:${r.line}`);
    lines.push(`    ${r.text.trim()}`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol() or read_range() to load specific results.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
