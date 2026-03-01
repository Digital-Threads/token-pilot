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
    return {
      content: [{
        type: 'text',
        text: `No results found for "${args.query}".${args.fuzzy ? '' : '\nHINT: Try fuzzy=true for broader matching.'}`,
      }],
    };
  }

  const lines: string[] = [
    `SEARCH: "${args.query}" (${results.length} results)`,
    '',
  ];

  for (const r of results) {
    const symbol = r.symbol ? ` [${r.symbol_kind ?? 'symbol'}: ${r.symbol}]` : '';
    lines.push(`  ${r.file}:${r.line}${symbol}`);
    lines.push(`    ${r.text.trim()}`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol() or read_range() to load specific results.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
