import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';
import type { ContextRegistry } from '../core/context-registry.js';
import type { ContextModeStatus } from '../integration/context-mode-detector.js';

/**
 * Detect if a file is a non-code structured file (JSON, YAML, Markdown, etc.)
 */
export function isNonCodeStructured(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ['.json', '.yaml', '.yml', '.md', '.markdown', '.toml', '.xml', '.csv'].includes(ext);
}

export interface NonCodeOptions {
  contextModeStatus?: ContextModeStatus;
  largeNonCodeThreshold?: number;
  adviseDelegation?: boolean;
}

/**
 * Generate a structural summary for non-code files.
 * Returns null if the file type is not supported.
 *
 * When context-mode is detected and the file exceeds the large threshold,
 * appends an advisory suggesting context-mode's execute_file for deeper analysis.
 */
export async function handleNonCodeRead(
  filePath: string,
  projectRoot: string,
  contextRegistry: ContextRegistry,
  options?: NonCodeOptions,
): Promise<{ content: Array<{ type: 'text'; text: string }> } | null> {
  const absPath = resolveSafePath(projectRoot, filePath);
  const content = await readFile(absPath, 'utf-8');
  const lines = content.split('\n');
  const ext = extname(absPath).toLowerCase();

  let summary: string;

  switch (ext) {
    case '.json':
      summary = summarizeJson(filePath, content, lines.length);
      break;
    case '.yaml':
    case '.yml':
      summary = summarizeYaml(filePath, content, lines.length);
      break;
    case '.md':
    case '.markdown':
      summary = summarizeMarkdown(filePath, content, lines.length);
      break;
    case '.toml':
      summary = summarizeToml(filePath, content, lines.length);
      break;
    default:
      return null;
  }

  // Append context-mode delegation advice for large non-code files
  const threshold = options?.largeNonCodeThreshold ?? 200;
  const advise = options?.adviseDelegation !== false;
  if (
    advise &&
    options?.contextModeStatus?.detected &&
    lines.length > threshold
  ) {
    summary += '\n\n---\nADVISORY: This is a large non-code file (' + lines.length + ' lines). '
      + 'context-mode is available — consider using execute_file or batch_execute '
      + 'for deeper analysis (BM25-indexed search, sandbox processing).';
  }

  const tokens = estimateTokens(summary);
  contextRegistry.trackLoad(absPath, {
    type: 'structure',
    startLine: 1,
    endLine: lines.length,
    tokens,
  });

  return { content: [{ type: 'text', text: summary }] };
}

function summarizeJson(filePath: string, content: string, lineCount: number): string {
  const lines: string[] = [
    `FILE: ${filePath} (${lineCount} lines, JSON)`,
    '',
  ];

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      lines.push(`TYPE: Array (${parsed.length} items)`);
      if (parsed.length > 0 && typeof parsed[0] === 'object') {
        lines.push(`ITEM KEYS: ${Object.keys(parsed[0]).join(', ')}`);
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      lines.push('TOP-LEVEL KEYS:');
      for (const [key, value] of Object.entries(parsed)) {
        const type = Array.isArray(value)
          ? `array[${value.length}]`
          : typeof value === 'object' && value !== null
            ? `object{${Object.keys(value).length} keys}`
            : typeof value;
        lines.push(`  ${key}: ${type}`);
      }
    }
  } catch {
    lines.push('(Invalid JSON — parse error)');
  }

  return lines.join('\n');
}

interface YamlNode {
  key: string;
  value?: string; // scalar value if present on same line
  children: YamlNode[];
  arrayItems: number; // count of `- ` items under this key
}

function summarizeYaml(filePath: string, content: string, lineCount: number): string {
  const lines: string[] = [
    `FILE: ${filePath} (${lineCount} lines, YAML)`,
    '',
    'STRUCTURE:',
  ];

  const rawLines = content.split('\n');
  const roots: YamlNode[] = [];

  // Stack tracks parent nodes at each indent level
  const stack: Array<{ node: YamlNode; indent: number }> = [];

  for (const line of rawLines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || !line.trim()) continue;

    // Count leading spaces
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Array item: `- key: value` or just `- value`
    const arrayMatch = line.match(/^(\s*)- /);
    if (arrayMatch) {
      // Count array item for nearest parent
      if (stack.length > 0) {
        // Find parent at indent level <= arrayMatch indent
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }
        if (stack.length > 0) {
          stack[stack.length - 1].node.arrayItems++;
        }
      }
      continue;
    }

    // Key: value or Key:
    const keyMatch = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_.-]*):\s*(.*)/);
    if (!keyMatch) continue;

    const keyIndent = keyMatch[1].length;
    const key = keyMatch[2];
    const rawValue = keyMatch[3].replace(/#.*$/, '').trim(); // strip inline comments

    const node: YamlNode = {
      key,
      value: rawValue && !rawValue.startsWith('{') && !rawValue.startsWith('[') && !rawValue.startsWith('|') && !rawValue.startsWith('>')
        ? rawValue
        : undefined,
      children: [],
      arrayItems: 0,
    };

    // Pop stack until we find a parent with less indent
    while (stack.length > 0 && stack[stack.length - 1].indent >= keyIndent) {
      stack.pop();
    }

    if (stack.length > 0) {
      const parent = stack[stack.length - 1].node;
      if (parent.children.length < 20) {
        parent.children.push(node);
      }
    } else {
      roots.push(node);
    }

    stack.push({ node, indent: keyIndent });
  }

  if (roots.length === 0) {
    lines.push('  (no top-level keys detected)');
  } else {
    for (const root of roots) {
      formatYamlNode(root, lines, 1, 3); // max 3 levels deep
    }
  }

  return lines.join('\n');
}

function formatYamlNode(node: YamlNode, lines: string[], depth: number, maxDepth: number): void {
  const indent = '  '.repeat(depth);

  if (node.value) {
    // Key with scalar value
    lines.push(`${indent}${node.key}: ${node.value}`);
  } else if (node.arrayItems > 0 && node.children.length === 0) {
    // Key with array of scalars
    lines.push(`${indent}${node.key}: [${node.arrayItems} items]`);
  } else if (node.children.length > 0) {
    // Key with children
    lines.push(`${indent}${node.key}:`);
    if (depth < maxDepth) {
      for (const child of node.children) {
        formatYamlNode(child, lines, depth + 1, maxDepth);
      }
      if (node.arrayItems > 0) {
        lines.push(`${indent}  (+ ${node.arrayItems} list items)`);
      }
    } else {
      lines.push(`${indent}  (${node.children.length} keys${node.arrayItems > 0 ? `, ${node.arrayItems} items` : ''})`);
    }
  } else {
    lines.push(`${indent}${node.key}`);
  }
}

function summarizeMarkdown(filePath: string, content: string, lineCount: number): string {
  const lines: string[] = [
    `FILE: ${filePath} (${lineCount} lines, Markdown)`,
    '',
    'TABLE OF CONTENTS:',
  ];

  // Extract headings
  for (const line of content.split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      const indent = '  '.repeat(level - 1);
      lines.push(`${indent}${match[2]}`);
    }
  }

  // Count code blocks
  const codeBlocks = (content.match(/```/g) || []).length / 2;
  if (codeBlocks > 0) {
    lines.push('');
    lines.push(`Code blocks: ${Math.floor(codeBlocks)}`);
  }

  return lines.join('\n');
}

function summarizeToml(filePath: string, content: string, lineCount: number): string {
  const lines: string[] = [
    `FILE: ${filePath} (${lineCount} lines, TOML)`,
    '',
    'SECTIONS:',
  ];

  // Extract [section] headers
  for (const line of content.split('\n')) {
    const match = line.match(/^\[([^\]]+)\]/);
    if (match) {
      lines.push(`  [${match[1]}]`);
    }
  }

  return lines.join('\n');
}
