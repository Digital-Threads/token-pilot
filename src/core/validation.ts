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
 * Validate read_symbols arguments (batch multi-symbol read).
 */
export function validateReadSymbolsArgs(args: unknown): {
  path: string;
  symbols: string[];
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
  if (!Array.isArray(a.symbols) || a.symbols.length === 0) {
    throw new Error('Required parameter "symbols" must be a non-empty array of strings.');
  }
  if (a.symbols.length > 10) {
    throw new Error('"symbols" can contain at most 10 symbols.');
  }
  for (const s of a.symbols) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new Error('Each symbol in "symbols" must be a non-empty string.');
    }
  }

  let show: 'full' | 'head' | 'tail' | 'outline' | undefined;
  if (a.show !== undefined && a.show !== null) {
    const valid = ['full', 'head', 'tail', 'outline'];
    if (typeof a.show !== 'string' || !valid.includes(a.show)) {
      throw new Error('"show" must be one of: full, head, tail, outline.');
    }
    show = a.show as typeof show;
  }

  return {
    path: a.path,
    symbols: a.symbols as string[],
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
 * v1.1: added scope, kind, limit, lang filters.
 */
export interface FindUsagesArgs {
  symbol: string;
  scope?: string;
  kind?: 'definitions' | 'imports' | 'usages' | 'all';
  limit?: number;
  lang?: string;
  context_lines?: number;
  mode?: 'full' | 'list';
}

export function validateFindUsagesArgs(args: unknown): FindUsagesArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.symbol !== 'string' || a.symbol.length === 0) {
    throw new Error('Required parameter "symbol" must be a non-empty string.');
  }

  let kind: FindUsagesArgs['kind'];
  if (a.kind !== undefined && a.kind !== null) {
    const validKinds = ['definitions', 'imports', 'usages', 'all'];
    if (typeof a.kind !== 'string' || !validKinds.includes(a.kind)) {
      throw new Error(`"kind" must be one of: ${validKinds.join(', ')}`);
    }
    kind = a.kind as FindUsagesArgs['kind'];
  }

  const limit = optionalNumber(a.limit, 'limit');
  if (limit !== undefined && (limit < 1 || limit > 500)) {
    throw new Error('"limit" must be between 1 and 500.');
  }

  const context_lines = optionalNumber(a.context_lines, 'context_lines');
  if (context_lines !== undefined && (context_lines < 0 || context_lines > 10)) {
    throw new Error('"context_lines" must be between 0 and 10.');
  }

  let mode: FindUsagesArgs['mode'];
  if (a.mode !== undefined && a.mode !== null) {
    const validModes = ['full', 'list'];
    if (typeof a.mode !== 'string' || !validModes.includes(a.mode)) {
      throw new Error(`"mode" must be one of: ${validModes.join(', ')}`);
    }
    mode = a.mode as FindUsagesArgs['mode'];
  }

  return {
    symbol: a.symbol,
    scope: optionalString(a.scope, 'scope'),
    kind,
    limit,
    lang: optionalString(a.lang, 'lang'),
    context_lines,
    mode,
  };
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
  if (typeof val !== 'number' || !Number.isFinite(val)) throw new Error(`"${name}" must be a finite number.`);
  return val;
}

/**
 * Validate read_for_edit arguments.
 */
export function validateReadForEditArgs(args: unknown): {
  path: string;
  symbol?: string;
  symbols?: string[];
  line?: number;
  context?: number;
  include_callers?: boolean;
  include_tests?: boolean;
  include_changes?: boolean;
  section?: string;
} {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  if (!a.symbol && !a.line && (!Array.isArray(a.symbols) || (a.symbols as unknown[]).length === 0) && !a.section) {
    throw new Error('Either "symbol", "symbols", "line", or "section" must be provided.');
  }

  // Validate symbols array (batch mode)
  let symbols: string[] | undefined;
  if (a.symbols !== undefined && a.symbols !== null) {
    if (!Array.isArray(a.symbols)) {
      throw new Error('"symbols" must be an array of strings.');
    }
    if (a.symbols.length > 10) {
      throw new Error('"symbols" can contain at most 10 symbols.');
    }
    for (const s of a.symbols) {
      if (typeof s !== 'string' || s.length === 0) {
        throw new Error('Each symbol in "symbols" must be a non-empty string.');
      }
    }
    symbols = a.symbols as string[];
  }

  return {
    path: a.path,
    symbol: optionalString(a.symbol, 'symbol'),
    symbols,
    line: optionalNumber(a.line, 'line'),
    context: optionalNumber(a.context, 'context'),
    include_callers: optionalBool(a.include_callers, 'include_callers'),
    include_tests: optionalBool(a.include_tests, 'include_tests'),
    include_changes: optionalBool(a.include_changes, 'include_changes'),
    section: optionalString(a.section, 'section'),
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
 * v1.1: added recursive, max_depth.
 */
export interface OutlineArgs {
  path: string;
  recursive?: boolean;
  max_depth?: number;
}

export function validateOutlineArgs(args: unknown): OutlineArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }

  const maxDepth = optionalNumber(a.max_depth, 'max_depth');
  if (maxDepth !== undefined && (maxDepth < 1 || maxDepth > 5)) {
    throw new Error('"max_depth" must be between 1 and 5.');
  }

  return {
    path: a.path,
    recursive: optionalBool(a.recursive, 'recursive'),
    max_depth: maxDepth,
  };
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

export interface CodeAuditArgs {
  check: 'pattern' | 'todo' | 'deprecated' | 'annotations' | 'all';
  pattern?: string;
  name?: string;
  lang?: string;
  limit?: number;
}

export function validateCodeAuditArgs(args: unknown): CodeAuditArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object with a "check" parameter.');
  }
  const a = args as Record<string, unknown>;

  const validChecks = ['pattern', 'todo', 'deprecated', 'annotations', 'all'];
  if (typeof a.check !== 'string' || !validChecks.includes(a.check)) {
    throw new Error(`Required parameter "check" must be one of: ${validChecks.join(', ')}`);
  }

  if (a.check === 'pattern') {
    if (typeof a.pattern !== 'string' || a.pattern.length === 0) {
      throw new Error('Parameter "pattern" is required when check="pattern". Example: "except:" or "print($$$ARGS)"');
    }
  }

  if (a.check === 'annotations') {
    if (typeof a.name !== 'string' || a.name.length === 0) {
      throw new Error('Parameter "name" is required when check="annotations". Example: "Deprecated" or "Controller"');
    }
  }

  return {
    check: a.check as CodeAuditArgs['check'],
    pattern: optionalString(a.pattern, 'pattern'),
    name: optionalString(a.name, 'name'),
    lang: optionalString(a.lang, 'lang'),
    limit: optionalNumber(a.limit, 'limit'),
  };
}

/**
 * Validate project_overview arguments.
 * v1.1: added include filter.
 */
export interface ProjectOverviewArgs {
  include?: Array<'stack' | 'ci' | 'quality' | 'architecture'>;
}

const VALID_INCLUDE_SECTIONS = ['stack', 'ci', 'quality', 'architecture'] as const;

export function validateProjectOverviewArgs(args: unknown): ProjectOverviewArgs {
  if (!args || typeof args !== 'object') return {};
  const a = args as Record<string, unknown>;

  if (a.include !== undefined && a.include !== null) {
    if (!Array.isArray(a.include)) {
      throw new Error('"include" must be an array of section names.');
    }
    for (const item of a.include) {
      if (typeof item !== 'string' || !(VALID_INCLUDE_SECTIONS as readonly string[]).includes(item)) {
        throw new Error(`Each element of "include" must be one of: ${VALID_INCLUDE_SECTIONS.join(', ')}. Got: "${item}"`);
      }
    }
    return { include: a.include as ProjectOverviewArgs['include'] };
  }

  return {};
}

/**
 * Validate module_info arguments.
 */
export interface ModuleInfoArgs {
  module: string;
  check?: 'deps' | 'dependents' | 'api' | 'unused-deps' | 'all';
}

export function validateModuleInfoArgs(args: unknown): ModuleInfoArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object with a "module" parameter.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.module !== 'string' || a.module.length === 0) {
    throw new Error('Required parameter "module" must be a non-empty string.');
  }

  let check: ModuleInfoArgs['check'];
  if (a.check !== undefined && a.check !== null) {
    const validChecks = ['deps', 'dependents', 'api', 'unused-deps', 'all'];
    if (typeof a.check !== 'string' || !validChecks.includes(a.check)) {
      throw new Error(`"check" must be one of: ${validChecks.join(', ')}`);
    }
    check = a.check as ModuleInfoArgs['check'];
  }

  return {
    module: a.module,
    check: check ?? 'all',
  };
}

/**
 * Validate smart_diff arguments.
 */
export interface SmartDiffArgs {
  scope?: 'unstaged' | 'staged' | 'commit' | 'branch';
  path?: string;
  ref?: string;
}

export function validateSmartDiffArgs(args: unknown): SmartDiffArgs {
  if (!args || typeof args !== 'object') return { scope: 'unstaged' };
  const a = args as Record<string, unknown>;

  let scope: SmartDiffArgs['scope'];
  if (a.scope !== undefined && a.scope !== null) {
    const validScopes = ['unstaged', 'staged', 'commit', 'branch'];
    if (typeof a.scope !== 'string' || !validScopes.includes(a.scope)) {
      throw new Error(`"scope" must be one of: ${validScopes.join(', ')}`);
    }
    scope = a.scope as SmartDiffArgs['scope'];
  }

  const ref = optionalString(a.ref, 'ref');
  if ((scope === 'commit' || scope === 'branch') && !ref) {
    throw new Error(`"ref" is required when scope="${scope}".`);
  }

  return {
    scope: scope ?? 'unstaged',
    path: optionalString(a.path, 'path'),
    ref,
  };
}

/**
 * Validate explore_area arguments.
 */
export interface ExploreAreaArgs {
  path: string;
  include?: Array<'outline' | 'imports' | 'tests' | 'changes'>;
}

const VALID_EXPLORE_SECTIONS = ['outline', 'imports', 'tests', 'changes'] as const;

export function validateExploreAreaArgs(args: unknown): ExploreAreaArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object with a "path" parameter.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }

  if (a.include !== undefined && a.include !== null) {
    if (!Array.isArray(a.include)) {
      throw new Error('"include" must be an array of section names.');
    }
    for (const item of a.include) {
      if (typeof item !== 'string' || !(VALID_EXPLORE_SECTIONS as readonly string[]).includes(item)) {
        throw new Error(`Each element of "include" must be one of: ${VALID_EXPLORE_SECTIONS.join(', ')}. Got: "${item}"`);
      }
    }
    return { path: a.path, include: a.include as ExploreAreaArgs['include'] };
  }

  return { path: a.path };
}

// ── smart_log ──

export interface SmartLogArgs {
  path?: string;
  count?: number;
  ref?: string;
}

export function validateSmartLogArgs(args: unknown): SmartLogArgs {
  if (!args || typeof args !== 'object') return {};
  const a = args as Record<string, unknown>;

  const path = optionalString(a.path, 'path');
  if (path !== undefined && path.length === 0) {
    throw new Error('"path" must be a non-empty string.');
  }

  const count = optionalNumber(a.count, 'count');
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new Error('"count" must be an integer between 1 and 50.');
    }
  }

  const ref = optionalString(a.ref, 'ref');
  if (ref !== undefined && ref.length === 0) {
    throw new Error('"ref" must be a non-empty string.');
  }

  return { path, count, ref };
}

// ── test_summary ──

export interface TestSummaryArgs {
  command: string;
  runner?: string;
  timeout?: number;
}

const VALID_RUNNERS = ['vitest', 'jest', 'pytest', 'phpunit', 'go', 'cargo', 'rspec', 'mocha'];

export function validateTestSummaryArgs(args: unknown): TestSummaryArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object with a "command" parameter.');
  }
  const a = args as Record<string, unknown>;

  if (typeof a.command !== 'string' || a.command.length === 0) {
    throw new Error('Required parameter "command" must be a non-empty string.');
  }

  let runner: string | undefined;
  if (a.runner !== undefined && a.runner !== null) {
    if (typeof a.runner !== 'string' || !VALID_RUNNERS.includes(a.runner)) {
      throw new Error(`"runner" must be one of: ${VALID_RUNNERS.join(', ')}`);
    }
    runner = a.runner;
  }

  const timeout = optionalNumber(a.timeout, 'timeout');
  if (timeout !== undefined) {
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) {
      throw new Error('"timeout" must be an integer between 1000 and 300000 (ms).');
    }
  }

  return { command: a.command, runner, timeout };
}

export function validateReadSectionArgs(args: unknown): { path: string; heading: string } {
  if (!args || typeof args !== 'object') {
    throw new Error('Arguments must be an object.');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error('Required parameter "path" must be a non-empty string.');
  }
  if (typeof a.heading !== 'string' || a.heading.length === 0) {
    throw new Error('Required parameter "heading" must be a non-empty string.');
  }
  return { path: a.path, heading: a.heading };
}

/** Detect roots that would cause ast-index to scan the entire filesystem */
export function isDangerousRoot(root: string): boolean {
  const normalized = root.replace(/\/+$/, '') || '/';
  // System roots
  if (normalized === '/' || normalized === '/tmp' || normalized === '/var') return true;
  // Home directories (macOS, Linux)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && normalized === home.replace(/\/+$/, '')) return true;
  // Common dangerous patterns: /Users, /home, /root, C:\, C:\Users
  if (/^\/(?:Users|home|root)$/.test(normalized)) return true;
  if (/^[A-Z]:\\(?:Users)?$/i.test(normalized)) return true;
  return false;
}
