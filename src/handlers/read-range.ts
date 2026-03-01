import { readFile } from 'node:fs/promises';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';

export interface ReadRangeArgs {
  path: string;
  start_line: number;
  end_line: number;
}

export async function handleReadRange(
  args: ReadRangeArgs,
  projectRoot: string,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);

  // Get lines
  const cached = fileCache.get(absPath);
  let lines: string[];

  if (cached) {
    lines = cached.lines;
  } else {
    const content = await readFile(absPath, 'utf-8');
    lines = content.split('\n');
  }

  const start = Math.max(0, args.start_line - 1);
  const end = Math.min(lines.length, args.end_line);

  if (start >= lines.length || start >= end) {
    return {
      content: [{
        type: 'text',
        text: `Invalid line range: ${args.start_line}-${args.end_line} (file has ${lines.length} lines)`,
      }],
    };
  }

  const outputLines: string[] = [
    `FILE: ${args.path} [L${args.start_line}-${args.end_line}]`,
    '',
  ];

  for (let i = start; i < end; i++) {
    const lineNum = String(i + 1).padStart(4);
    outputLines.push(`${lineNum} | ${lines[i]}`);
  }

  const output = outputLines.join('\n');
  const tokens = estimateTokens(output);

  contextRegistry.trackLoad(absPath, {
    type: 'range',
    startLine: args.start_line,
    endLine: args.end_line,
    tokens,
  });

  return { content: [{ type: 'text', text: output }] };
}
