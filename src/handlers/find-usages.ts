import type { AstIndexClient } from '../ast-index/client.js';

export interface FindUsagesArgs {
  symbol: string;
}

export async function handleFindUsages(
  args: FindUsagesArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const results = await astIndex.usages(args.symbol);

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No usages found for "${args.symbol}".`,
      }],
    };
  }

  const lines: string[] = [
    `USAGES: "${args.symbol}" (${results.length} total)`,
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
