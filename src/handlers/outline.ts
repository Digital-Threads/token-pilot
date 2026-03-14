import { readdir, stat } from 'node:fs/promises';
import { resolve, basename, relative } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { SymbolInfo } from '../types.js';
import { resolveSafePath } from '../core/validation.js';
import type { OutlineArgs } from '../core/validation.js';

export const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'cs', 'cpp', 'cc', 'cxx', 'hpp', 'c', 'h', 'php', 'rb', 'scala',
  'dart', 'lua', 'sh', 'bash', 'sql', 'r', 'vue', 'svelte', 'pl', 'pm',
  'ex', 'exs', 'groovy', 'm', 'proto', 'bsl',
  'lisp', 'lsp', 'cl', 'asd',
]);

// Standard HTTP verbs — protocol-level, not framework-specific
const HTTP_VERBS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'All'];
const HTTP_VERB_PATTERN = new RegExp(
  `^(${HTTP_VERBS.join('|')})(?:Mapping)?\\((?:'([^']*)'|"([^"]*)")?\\)$`, 'i',
);

export async function handleOutline(
  args: OutlineArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);

  // Verify it's a directory
  const pathStat = await stat(absPath).catch(() => null);
  if (!pathStat || !pathStat.isDirectory()) {
    return {
      content: [{
        type: 'text',
        text: `"${args.path}" is not a directory. Use smart_read() for individual files.`,
      }],
    };
  }

  const recursive = args.recursive ?? false;
  const maxDepth = args.max_depth ?? 2;

  const sections: string[] = [];
  await outlineDir(absPath, sections, 0, recursive ? maxDepth : 0, projectRoot, astIndex);

  sections.push('HINT: Use outline(path) on subdirs, smart_read(path) for file structure, read_symbol(path, symbol) for source code.');

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

/** Max output lines to prevent runaway recursive outlines */
const MAX_OUTLINE_LINES = 500;

/**
 * Outline a single directory. When depth < maxDepth and recursive,
 * recurse into subdirectories. Otherwise show file counts only.
 */
export async function outlineDir(
  absPath: string,
  sections: string[],
  depth: number,
  maxDepth: number,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<void> {
  // Guard: stop if output is already too large
  if (sections.length >= MAX_OUTLINE_LINES) {
    if (!sections[sections.length - 1]?.startsWith('⚠')) {
      sections.push(`⚠ Output truncated at ${MAX_OUTLINE_LINES} lines. Use outline() on specific subdirectories for details.`);
    }
    return;
  }

  // List code files and subdirectories
  const entries = await readdir(absPath, { withFileTypes: true });
  const codeFiles: string[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (CODE_EXTENSIONS.has(ext)) {
        codeFiles.push(resolve(absPath, entry.name));
      }
    }
  }

  if (codeFiles.length === 0 && subdirs.length === 0) {
    if (depth === 0) {
      sections.push(`No code files or subdirectories found in "${relative(projectRoot, absPath) || '.'}".`);
    }
    return;
  }

  // Sort
  codeFiles.sort();
  subdirs.sort();

  const relDir = relative(projectRoot, absPath) || '.';
  const indent = '  '.repeat(depth);
  const totalLabel = codeFiles.length > 0 ? `${codeFiles.length} files` : '';
  const subLabel = subdirs.length > 0 ? `${subdirs.length} subdirs` : '';
  const countLabel = [totalLabel, subLabel].filter(Boolean).join(', ');
  sections.push(`${indent}OUTLINE: ${relDir}/ (${countLabel})`);
  sections.push('');

  // Show subdirectories
  if (subdirs.length > 0) {
    if (depth < maxDepth) {
      // Recursive: outline each subdir
      for (const sub of subdirs) {
        const subPath = resolve(absPath, sub);
        await outlineDir(subPath, sections, depth + 1, maxDepth, projectRoot, astIndex);
      }
    } else {
      // Non-recursive: show file counts only
      for (const sub of subdirs) {
        const subPath = resolve(absPath, sub);
        const fileCount = await countCodeFiles(subPath);
        sections.push(`${indent}  ${sub}/ (${fileCount} code files)`);
      }
      sections.push('');
    }
  }

  // Show code files at this level with AST outline
  const fileIndent = '  '.repeat(depth + 1);
  const symbolIndent = depth + 2;

  for (const filePath of codeFiles) {
    const name = basename(filePath);

    try {
      const structure = await astIndex.outline(filePath);
      if (!structure) {
        sections.push(`${fileIndent}${name} (no AST)`);
        sections.push('');
        continue;
      }

      sections.push(`${fileIndent}${name} (${structure.meta.lines} lines)`);

      for (const sym of structure.symbols) {
        formatCompactSymbol(sym, sections, symbolIndent);
      }
      sections.push('');
    } catch {
      sections.push(`${fileIndent}${name} (outline failed)`);
      sections.push('');
    }
  }
}

/**
 * Format a symbol in compact outline form.
 * For classes: show name + member count.
 * If class has a route-prefix decorator + children with HTTP verb decorators → show routes.
 * Universal: works with any framework using @Decorator('/path') + @Verb('/route') pattern.
 */
function formatCompactSymbol(sym: SymbolInfo, lines: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  const loc = formatLoc(sym);

  if (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'enum') {
    // Check if class has a route-prefix decorator (any decorator with a path arg)
    const routePrefix = extractRoutePrefix(sym.decorators);

    if (routePrefix !== null && sym.children.length > 0) {
      // Route-based class — show decorator + HTTP routes for children
      const prefixDec = sym.decorators.find(d => extractPathArg(d) !== null);
      lines.push(`${indent}@${prefixDec}`);

      for (const child of sym.children) {
        const route = extractHttpRoute(child.decorators, routePrefix.path);
        if (route) {
          lines.push(`${indent}  ${route} → ${child.name}()  ${formatLoc(child)}`);
        } else {
          // Show decorators for non-HTTP methods too
          const childDecs = (child.decorators ?? []).map(d => `@${d}`).join(' ');
          const decStr = childDecs ? `  ${childDecs}` : '';
          lines.push(`${indent}  ${child.name}()  ${formatLoc(child)}${decStr}`);
        }
      }
    } else if (sym.children.length > 0) {
      const memberSummary = sym.children.length <= 6
        ? sym.children.map(c => c.name).join(', ')
        : sym.children.slice(0, 5).map(c => c.name).join(', ') + `, ... (${sym.children.length} total)`;
      // Show class decorators if any
      for (const dec of (sym.decorators ?? [])) {
        lines.push(`${indent}@${dec}`);
      }
      lines.push(`${indent}${sym.kind} ${sym.name} ${loc} — ${memberSummary}`);
    } else {
      lines.push(`${indent}${sym.kind} ${sym.name} ${loc}`);
    }
  } else {
    // Function, variable, etc — show decorators if any
    for (const dec of (sym.decorators ?? [])) {
      lines.push(`${indent}@${dec}`);
    }
    const asyncPrefix = sym.async ? 'async ' : '';
    lines.push(`${indent}${asyncPrefix}${sym.name} ${loc}`);
  }
}

function formatLoc(sym: SymbolInfo): string {
  return `[L${sym.location.startLine}-${sym.location.endLine}]`;
}

/**
 * Extract a path argument from any decorator: Name('/path') or Name("/path")
 */
function extractPathArg(decorator: string): string | null {
  const match = decorator.match(/^\w+\((?:'([^']*)'|"([^"]*)")\)$/);
  if (match) return match[1] ?? match[2] ?? '';
  return null;
}

/**
 * Check if class has a route-prefix decorator.
 * Heuristic: any decorator with a path arg that starts with '/' or is empty
 * and whose children have HTTP verb decorators.
 */
function extractRoutePrefix(decorators: string[]): { path: string } | null {
  if (!decorators) return null;
  for (const dec of decorators) {
    const path = extractPathArg(dec);
    if (path !== null) return { path };
  }
  return null;
}

/**
 * Extract HTTP route from decorators using standard HTTP verbs.
 * Works with: @Get('/path'), @PostMapping('/path'), etc.
 */
function extractHttpRoute(decorators: string[], parentRoute: string): string | null {
  if (!decorators) return null;
  for (const dec of decorators) {
    const match = dec.match(HTTP_VERB_PATTERN);
    if (match) {
      const verb = match[1].toUpperCase();
      const route = match[2] ?? match[3] ?? '';
      const fullRoute = `${parentRoute}/${route}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      return `${verb.padEnd(7)} ${fullRoute}`;
    }
  }
  return null;
}

/**
 * Recursively count code files in a directory.
 * Max depth 5 to avoid runaway scans.
 */
async function countCodeFiles(dirPath: string, depth = 0): Promise<number> {
  if (depth > 5) return 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (CODE_EXTENSIONS.has(ext)) count++;
      } else if (entry.isDirectory()) {
        count += await countCodeFiles(resolve(dirPath, entry.name), depth + 1);
      }
    }
    return count;
  } catch {
    return 0;
  }
}
