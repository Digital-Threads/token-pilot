import { resolve, relative } from 'node:path';

/**
 * Resolve a user-provided path and validate it stays within projectRoot.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 */
export function resolveSafePath(projectRoot: string, userPath: string): string {
  const absPath = resolve(projectRoot, userPath);
  const rel = relative(projectRoot, absPath);

  if (rel.startsWith('..') || resolve(projectRoot, rel) !== absPath) {
    throw new Error(`Path "${userPath}" resolves outside project root.`);
  }

  return absPath;
}

/**
 * Validate smart_read arguments.
 */
export function validateSmartReadArgs(args: unknown): {
  path: string;
  show_imports?: boolean;
  show_docs?: boolean;
  show_references?: boolean;
  depth?: number;
} {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  return {
    path: a.path,
    show_imports: optionalBool(a.show_imports, 'show_imports'),
    show_docs: optionalBool(a.show_docs, 'show_docs'),
    show_references: optionalBool(a.show_references, 'show_references'),
    depth: optionalNumber(a.depth, 'depth'),
  };
}

/**
 * Validate read_symbol arguments.
 */
export function validateReadSymbolArgs(args: unknown): {
  path: string;
  symbol: string;
  context_before?: number;
  context_after?: number;
  show?: 'full' | 'head' | 'tail' | 'outline';
} {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  if (typeof a.symbol !== 'string' || a.symbol.length === 0) {
    throw new Error('Required parameter "symbol" must be a non-empty string.');
  }

  let show: 'full' | 'head' | 'tail' | 'outline' | undefined;
  if (a.show !== undefined && a.show !== null) {
    const valid = ['full', 'head', 'tail', 'outline'];
    if (typeof a.show !== 'string' || !valid.includes(a.show)) {
      throw new Error('"show" must be one of: full, head, tail, outline.');
    }
    show = a.show as 'full' | 'head' | 'tail' | 'outline';
  }

  return {
    path: a.path,
    symbol: a.symbol,
    context_before: optionalNumber(a.context_before, 'context_before'),
    context_after: optionalNumber(a.context_after, 'context_after'),
    show,
  };
}

/**
 * Validate read_range arguments.
 */
export function validateReadRangeArgs(args: unknown): {
  path: string;
  start_line: number;
  end_line: number;
} {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  if (typeof a.start_line !== 'number' || !Number.isInteger(a.start_line) || a.start_line < 1) {
    throw new Error('Required parameter "start_line" must be a positive integer.');
  }
  if (typeof a.end_line !== 'number' || !Number.isInteger(a.end_line) || a.end_line < 1) {
    throw new Error('Required parameter "end_line" must be a positive integer.');
  }
  if (a.end_line < a.start_line) {
    throw new Error('"end_line" must be >= "start_line".');
  }
  return { path: a.path, start_line: a.start_line, end_line: a.end_line };
}

/**
 * Validate read_diff arguments.
 */
export function validateReadDiffArgs(args: unknown): {
  path: string;
  context_lines?: number;
} {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  return {
    path: a.path,
    context_lines: optionalNumber(a.context_lines, 'context_lines'),
  };
}

/**
 * Validate find_usages arguments.
 */
export function validateFindUsagesArgs(args: unknown): { symbol: string } {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.symbol !== 'string' || a.symbol.length === 0) {
    throw new Error('Required parameter "symbol" must be a non-empty string.');
  }
  return { symbol: a.symbol };
}

/**
 * Validate smart_read_many arguments.
 */
export function validateSmartReadManyArgs(args: unknown): { paths: string[] } {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a.paths)) {
    throw new Error('Required parameter "paths" must be an array of strings.');
  }
  for (const p of a.paths) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('Each path in "paths" must be a non-empty string.');
    }
  }
  return { paths: a.paths as string[] };
}

function optionalString(val: unknown, name: string): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new Error(`"${name}" must be a string.`);
  return val;
}

function optionalBool(val: unknown, name: string): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new Error(`"${name}" must be a boolean.`);
  return val;
}

function optionalNumber(val: unknown, name: string): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new Error(`"${name}" must be a number.`);
  return val;
}

/**
 * Validate read_for_edit arguments.
 */
export function validateReadForEditArgs(args: unknown): {
  path: string;
  symbol?: string;
  line?: number;
  context?: number;
} {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  if (!a.symbol && !a.line) {
    throw new Error('Either "symbol" or "line" must be provided.');
  }
  return {
    path: a.path,
    symbol: optionalString(a.symbol, 'symbol'),
    line: optionalNumber(a.line, 'line'),
    context: optionalNumber(a.context, 'context'),
  };
}

/**
 * Validate related_files arguments.
 */
export function validateRelatedFilesArgs(args: unknown): { path: string } {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  return { path: a.path };
}

/**
 * Validate outline arguments.
 */
export function validateOutlineArgs(args: unknown): { path: string } {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  return { path: a.path };
}

export function validateFindUnusedArgs(args: unknown): {
  module?: string;
  export_only?: boolean;
  limit?: number;
} {
  if (!args || typeof args !== 'object') return {};
  const a = args as Record<string, unknown>;
  return {
    module: optionalString(a.module, 'module'),
    export_only: optionalBool(a.export_only, 'export_only'),
    limit: optionalNumber(a.limit, 'limit'),
  };
}
