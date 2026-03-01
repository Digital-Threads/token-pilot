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
    const hints = [`No usages found for "${args.symbol}".`];
    if (!astIndex.isAvailable()) {
      hints.push('WARNING: ast-index is not available. Install it: cargo install ast-index');
    } else {
      hints.push('TIP: Index may not cover this language/project. Run `ast-index build` in the project root.');
      hints.push('TIP: Use Grep as a fallback for text-based search.');
    }
    return { content: [{ type: 'text', text: hints.join('\n') }] };
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
