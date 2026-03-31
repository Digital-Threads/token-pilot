import type { FileStructure, SymbolInfo } from '../types.js';

export interface FormatOptions {
  showImports?: boolean;
  showDocs?: boolean;
  showDependencyHints?: boolean;
  maxDepth?: number;
  showTokenSavings?: boolean;
  scope?: 'full' | 'nav' | 'exports';
}

/**
 * Format a FileStructure as token-optimized text for LLMs.
 */
export function formatOutline(structure: FileStructure, options: FormatOptions = {}): string {
  const {
    showImports = true,
    showDocs = true,
    showDependencyHints = true,
    maxDepth = 2,
    scope = 'full',
  } = options;

  const lines: string[] = [];

  // Header
  const sizeKB = (structure.meta.bytes / 1024).toFixed(1);
  const scopeLabel = scope !== 'full' ? `, ${scope} mode` : '';
  lines.push(`FILE: ${structure.path} (${structure.meta.lines} lines, ${sizeKB}KB${scopeLabel})`);
  lines.push(`LANGUAGE: ${structure.language}`);
  lines.push('');

  // NAV scope: compact names + line ranges only
  if (scope === 'nav') {
    lines.push('SYMBOLS:');
    for (const sym of structure.symbols) {
      formatSymbolNav(sym, lines, 1, maxDepth);
    }
    lines.push('');
    lines.push('HINT: Use scope="full" for type signatures and imports. Use read_symbol(path, symbol) to load code.');
    return lines.join('\n');
  }

  // EXPORTS scope: only exported symbols
  if (scope === 'exports') {
    const exportNames = new Set(structure.exports.map(e => e.name));
    const exportedSymbols = structure.symbols.filter(s => exportNames.has(s.name));
    const hiddenCount = structure.symbols.length - exportedSymbols.length;

    lines.push('EXPORTS:');
    for (const exp of structure.exports) {
      const defaultLabel = exp.isDefault ? ' (default)' : '';
      lines.push(`  ${exp.kind} ${exp.name}${defaultLabel}`);
    }
    lines.push('');

    lines.push('STRUCTURE:');
    for (const sym of exportedSymbols) {
      formatSymbolTree(sym, lines, 1, maxDepth, showDocs, showDependencyHints);
    }
    lines.push('');

    if (hiddenCount > 0) {
      lines.push(`HINT: ${hiddenCount} non-exported symbol(s) hidden. Use scope="full" to see all symbols.`);
    } else {
      lines.push('HINT: Use read_symbol(path, symbol) to load a specific symbol\'s code.');
    }
    return lines.join('\n');
  }

  // Imports
  if (showImports && structure.imports.length > 0) {
    lines.push('IMPORTS:');
    for (const imp of structure.imports) {
      if (imp.isNamespace) {
        lines.push(`  * as ${imp.specifiers[0]} from '${imp.source}'`);
      } else if (imp.isDefault) {
        lines.push(`  ${imp.specifiers[0]} from '${imp.source}'`);
      } else {
        lines.push(`  { ${imp.specifiers.join(', ')} } from '${imp.source}'`);
      }
    }
    lines.push('');
  }

  // Exports
  if (structure.exports.length > 0) {
    lines.push('EXPORTS:');
    for (const exp of structure.exports) {
      const defaultLabel = exp.isDefault ? ' (default)' : '';
      lines.push(`  ${exp.kind} ${exp.name}${defaultLabel}`);
    }
    lines.push('');
  }

  // Structure (cap at 40 top-level symbols to prevent outline explosion)
  const MAX_OUTLINE_SYMBOLS = 40;
  lines.push('STRUCTURE:');
  const symbolsCapped = structure.symbols.length > MAX_OUTLINE_SYMBOLS;
  const displayedSymbols = symbolsCapped ? structure.symbols.slice(0, MAX_OUTLINE_SYMBOLS) : structure.symbols;
  for (const sym of displayedSymbols) {
    formatSymbolTree(sym, lines, 1, maxDepth, showDocs, showDependencyHints);
  }
  if (symbolsCapped) {
    lines.push(`  ... and ${structure.symbols.length - MAX_OUTLINE_SYMBOLS} more symbols (use read_symbol for details)`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol(path="<this file>", symbol="<name>") to load a specific symbol. Supports Class.method and Class::method.');

  return lines.join('\n');
}

function formatSymbolTree(
  sym: SymbolInfo,
  lines: string[],
  depth: number,
  maxDepth: number,
  showDocs: boolean,
  showDeps: boolean,
  parentDecorators?: string[],
): void {
  const indent = '  '.repeat(depth);
  const asyncPrefix = sym.async ? 'async ' : '';
  const staticPrefix = sym.static ? 'static ' : '';
  const visPrefix = sym.visibility !== 'default' ? `${sym.visibility} ` : '';

  // Framework-aware: try to show HTTP route instead of raw decorators
  const frameworkInfo = formatFrameworkInfo(sym.decorators, parentDecorators);

  if (frameworkInfo) {
    // Show framework info line (e.g. "GET /admin/users → getUsers()")
    const loc = `[L${sym.location.startLine}-${sym.location.endLine}]`;
    lines.push(`${indent}${frameworkInfo} ${loc}`);
  } else {
    // Regular decorators
    for (const dec of sym.decorators) {
      lines.push(`${indent}@${dec}`);
    }

    // Symbol line
    const loc = `[L${sym.location.startLine}-${sym.location.endLine}]`;
    const lineCount = `(${sym.location.lineCount} lines)`;

    if (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'enum') {
      lines.push(`${indent}${sym.kind} ${sym.name}: ${loc} ${lineCount}`);
    } else {
      lines.push(`${indent}- ${visPrefix}${staticPrefix}${asyncPrefix}${sym.signature} ${loc} ${lineCount}`);
    }
  }

  // Dependency hints (references)
  if (showDeps && sym.references.length > 0) {
    lines.push(`${indent}    calls: ${sym.references.join(', ')}`);
  }

  // Children (cap at 30 per group to prevent explosion on large classes)
  const MAX_CHILDREN = 30;
  if (depth < maxDepth && sym.children.length > 0) {
    // Group by visibility
    const publicMethods = sym.children.filter(c => c.visibility === 'public' || c.visibility === 'default');
    const privateMethods = sym.children.filter(c => c.visibility === 'private' || c.visibility === 'protected');

    if (publicMethods.length > 0) {
      lines.push(`${indent}  Public Methods:`);
      const pubDisplay = publicMethods.slice(0, MAX_CHILDREN);
      for (const child of pubDisplay) {
        formatSymbolTree(child, lines, depth + 2, maxDepth, showDocs, showDeps, sym.decorators);
      }
      if (publicMethods.length > MAX_CHILDREN) {
        lines.push(`${indent}    ... and ${publicMethods.length - MAX_CHILDREN} more public methods`);
      }
    }

    if (privateMethods.length > 0) {
      lines.push(`${indent}  Private Methods:`);
      const privDisplay = privateMethods.slice(0, MAX_CHILDREN);
      for (const child of privDisplay) {
        formatSymbolTree(child, lines, depth + 2, maxDepth, showDocs, showDeps, sym.decorators);
      }
      if (privateMethods.length > MAX_CHILDREN) {
        lines.push(`${indent}    ... and ${privateMethods.length - MAX_CHILDREN} more private methods`);
      }
    }
  } else if (sym.children.length > 0) {
    lines.push(`${indent}  (${sym.children.length} members — increase depth to see)`);
  }
}

function formatSymbolNav(sym: SymbolInfo, lines: string[], depth: number, maxDepth: number): void {
  const indent = '  '.repeat(depth);
  const loc = `[L${sym.location.startLine}-${sym.location.endLine}]`;
  const callable = sym.kind === 'function' || sym.kind === 'method' ? '()' : '';
  lines.push(`${indent}${sym.name}${callable} ${loc}`);
  if (depth < maxDepth && sym.children.length > 0) {
    for (const child of sym.children) {
      formatSymbolNav(child, lines, depth + 1, maxDepth);
    }
  }
}

/**
 * Detect HTTP route decorators and format as "METHOD /path".
 * Uses standard HTTP verbs — not framework-specific.
 * Works with any framework that uses @Get('/path'), @Post('/path') etc.
 *
 * For parent route prefix, looks for any decorator with pattern Name('/path')
 * on the parent class (e.g. @Controller('/users'), @Router('/api'), @Blueprint('/v1')).
 *
 * Returns formatted route string, or null if no HTTP decorator found.
 * Non-HTTP decorators are shown as-is by the caller (no framework hardcoding).
 */
function formatFrameworkInfo(decorators: string[], parentDecorators?: string[]): string | null {
  if (!decorators || decorators.length === 0) return null;

  // Standard HTTP verbs — these are protocol-level, not framework-specific
  const HTTP_VERBS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'All'];
  // Common suffixed forms: GetMapping (Spring), get_mapping, etc.
  const HTTP_VERB_PATTERN = new RegExp(
    `^(${HTTP_VERBS.join('|')})(?:Mapping)?\\((?:'([^']*)'|"([^"]*)")?\\)$`, 'i',
  );

  for (const dec of decorators) {
    const match = dec.match(HTTP_VERB_PATTERN);
    if (match) {
      const verb = match[1].toUpperCase();
      const route = match[2] ?? match[3] ?? '';

      // Extract parent route prefix from any decorator with path pattern on parent
      let parentRoute = '';
      if (parentDecorators) {
        for (const pd of parentDecorators) {
          // Match: AnyName('/path') or AnyName("/path")
          const pm = pd.match(/^\w+\((?:'([^']*)'|"([^"]*)")\)$/);
          if (pm) {
            parentRoute = pm[1] ?? pm[2] ?? '';
            break;
          }
        }
      }

      const fullRoute = `${parentRoute}/${route}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      return `${verb.padEnd(7)} ${fullRoute}`;
    }
  }

  return null;
}
