import type { AstIndexClient } from '../ast-index/client.js';
import type { AstIndexHierarchyNode } from '../ast-index/types.js';

export interface ClassHierarchyArgs {
  name: string;
}

export async function handleClassHierarchy(
  args: ClassHierarchyArgs,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const tree = await astIndex.hierarchy(args.name);

  if (!tree) {
    return {
      content: [{
        type: 'text',
        text: `No hierarchy found for "${args.name}".`,
      }],
    };
  }

  const lines: string[] = [
    `HIERARCHY: "${args.name}"`,
    '',
  ];

  formatNode(tree, lines, 0);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatNode(node: AstIndexHierarchyNode, lines: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  const loc = node.file ? ` (${node.file}:${node.line})` : '';
  lines.push(`${indent}${node.kind} ${node.name}${loc}`);

  if (node.children) {
    for (const child of node.children) {
      formatNode(child, lines, depth + 1);
    }
  }
}
