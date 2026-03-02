import type { AstIndexClient } from '../ast-index/client.js';
import type { AstIndexCallTreeNode } from '../ast-index/types.js';

export interface FindCallersArgs {
  function: string;
  depth?: number;
}

export async function handleFindCallers(
  args: FindCallersArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const depth = args.depth ?? 1;

  // depth=1: flat callers list, depth>1: call tree
  if (depth <= 1) {
    const callers = await astIndex.callers(args.function);

    if (callers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No callers found for "${args.function}".\nTIP: ast-index callers tracks direct function calls. Method calls via objects (this.service.method()) may not be detected.`,
        }],
      };
    }

    const lines: string[] = [
      `CALLERS: "${args.function}" (${callers.length} callers)`,
      '',
    ];

    for (const c of callers) {
      lines.push(`  ${c.path}:${c.line}`);
      if (c.context) lines.push(`    ${c.context.trim()}`);
    }

    lines.push('');
    lines.push('HINT: Use depth=2+ to see the full call hierarchy tree.');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // Call tree mode
  const tree = await astIndex.callTree(args.function, depth);

  if (!tree) {
    return {
      content: [{
        type: 'text',
        text: `No call tree found for "${args.function}".`,
      }],
    };
  }

  const lines: string[] = [
    `CALL TREE: "${args.function}" (depth=${depth})`,
    '',
  ];

  formatCallTree(tree, lines, 0);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatCallTree(node: AstIndexCallTreeNode, lines: string[], indent: number): void {
  const prefix = '  '.repeat(indent);
  const loc = node.file ? ` (${node.file}:${node.line ?? '?'})` : '';
  lines.push(`${prefix}${indent === 0 ? '' : '← '}${node.name}${loc}`);

  if (node.callers) {
    for (const caller of node.callers) {
      formatCallTree(caller, lines, indent + 1);
    }
  }
}
