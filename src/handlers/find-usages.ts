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

  // Group by kind
  const definitions = results.filter(r => r.kind === 'definition');
  const calls = results.filter(r => r.kind === 'call');
  const imports = results.filter(r => r.kind === 'import');
  const references = results.filter(r => r.kind === 'reference');

  const lines: string[] = [
    `USAGES: "${args.symbol}" (${results.length} total)`,
    '',
  ];

  if (definitions.length > 0) {
    lines.push('  Definitions:');
    for (const d of definitions) {
      lines.push(`    ${d.file}:${d.line} ${d.enclosing_symbol ? `(in ${d.enclosing_symbol})` : ''}`);
    }
  }

  if (calls.length > 0) {
    lines.push('  Calls:');
    for (const c of calls) {
      lines.push(`    ${c.file}:${c.line} ${c.enclosing_symbol ? `(in ${c.enclosing_symbol})` : ''}`);
    }
  }

  if (imports.length > 0) {
    lines.push('  Imports:');
    for (const i of imports) {
      lines.push(`    ${i.file}:${i.line}`);
    }
  }

  if (references.length > 0) {
    lines.push('  References:');
    for (const r of references) {
      lines.push(`    ${r.file}:${r.line} ${r.enclosing_symbol ? `(in ${r.enclosing_symbol})` : ''}`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
