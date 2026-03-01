import type { AstIndexClient } from '../ast-index/client.js';

export interface ChangedSymbolsArgs {
  base?: string;
}

export async function handleChangedSymbols(
  args: ChangedSymbolsArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const changed = await astIndex.changed(args.base);

  if (changed.length === 0) {
    const base = args.base ?? 'origin/main';
    return {
      content: [{
        type: 'text',
        text: `No changed symbols since ${base}.\nTIP: This uses git diff. Make sure you have uncommitted changes or are on a feature branch.`,
      }],
    };
  }

  // Group by change type
  const added = changed.filter(c => c.change_type === 'added');
  const modified = changed.filter(c => c.change_type === 'modified');
  const removed = changed.filter(c => c.change_type === 'removed');

  const lines: string[] = [
    `CHANGED SYMBOLS: ${changed.length} total (${added.length} added, ${modified.length} modified, ${removed.length} removed)`,
    '',
  ];

  if (added.length > 0) {
    lines.push('ADDED:');
    for (const s of added) {
      lines.push(`  + ${s.kind} ${s.name} (${s.file}:${s.line})`);
    }
    lines.push('');
  }

  if (modified.length > 0) {
    lines.push('MODIFIED:');
    for (const s of modified) {
      lines.push(`  ~ ${s.kind} ${s.name} (${s.file}:${s.line})`);
    }
    lines.push('');
  }

  if (removed.length > 0) {
    lines.push('REMOVED:');
    for (const s of removed) {
      lines.push(`  - ${s.kind} ${s.name} (${s.file}:${s.line})`);
    }
    lines.push('');
  }

  lines.push('HINT: Use read_symbol() to see the actual code changes.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
