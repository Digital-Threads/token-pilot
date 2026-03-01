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
    return {
      content: [{
        type: 'text',
        text: `No implementations found for "${args.name}".`,
      }],
    };
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
