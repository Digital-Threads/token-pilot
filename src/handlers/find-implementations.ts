import type { AstIndexClient } from '../ast-index/client.js';

export interface FindImplementationsArgs {
  name: string;
}

export async function handleFindImplementations(
  args: FindImplementationsArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const results = await astIndex.implementations(args.name);

  if (results.length === 0) {
    const hints = [`No implementations found for "${args.name}".`];
    if (!astIndex.isAvailable()) {
      hints.push('WARNING: ast-index is not available. Install it: cargo install ast-index');
    } else {
      hints.push('TIP: Index may not cover this language/project. Run `ast-index build` in the project root.');
    }
    return { content: [{ type: 'text', text: hints.join('\n') }] };
  }

  const lines: string[] = [
    `IMPLEMENTATIONS: "${args.name}" (${results.length} found)`,
    '',
  ];

  for (const impl of results) {
    const methods = impl.methods?.length
      ? ` — methods: ${impl.methods.join(', ')}`
      : '';
    lines.push(`  ${impl.kind} ${impl.name} (${impl.file}:${impl.line})${methods}`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol() to inspect a specific implementation.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
