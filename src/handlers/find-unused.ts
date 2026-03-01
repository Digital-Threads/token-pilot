import type { AstIndexClient } from '../ast-index/client.js';

export interface FindUnusedArgs {
  module?: string;
  export_only?: boolean;
  limit?: number;
}

export async function handleFindUnused(
  args: FindUnusedArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const unused = await astIndex.unusedSymbols({
    module: args.module,
    exportOnly: args.export_only,
    limit: args.limit ?? 30,
  });

  if (unused.length === 0) {
    return {
      content: [{
        type: 'text',
        text: args.module
          ? `No unused symbols found in module "${args.module}".`
          : 'No unused symbols found in the project.',
      }],
    };
  }

  const lines: string[] = [
    `UNUSED SYMBOLS: ${unused.length} potentially unused`,
    '',
  ];

  // Group by file
  const byFile = new Map<string, typeof unused>();
  for (const sym of unused) {
    const existing = byFile.get(sym.path) ?? [];
    existing.push(sym);
    byFile.set(sym.path, existing);
  }

  for (const [file, symbols] of byFile) {
    lines.push(`  ${file}:`);
    for (const s of symbols) {
      lines.push(`    ${s.kind} ${s.name} (L${s.line})`);
    }
  }

  lines.push('');
  lines.push('NOTE: These symbols have no detected usages in the indexed codebase. Verify before removing — they may be used dynamically or in tests.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
