import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AstIndexClient } from './ast-index/client.js';
import { FileCache } from './core/file-cache.js';
import { ContextRegistry } from './core/context-registry.js';
import { SymbolResolver } from './core/symbol-resolver.js';
import { SessionAnalytics } from './core/session-analytics.js';
import { formatDuration } from './core/format-duration.js';
import { loadConfig } from './config/loader.js';
import { readFileSync } from 'node:fs';
import { GitWatcher } from './git/watcher.js';
import { FileWatcher } from './git/file-watcher.js';
import { handleSmartRead } from './handlers/smart-read.js';
import { handleReadSymbol } from './handlers/read-symbol.js';
import { handleReadRange } from './handlers/read-range.js';
import { handleReadDiff } from './handlers/read-diff.js';
import { handleSearchCode } from './handlers/search-code.js';
import { handleFindUsages } from './handlers/find-usages.js';
import { handleFindImplementations } from './handlers/find-implementations.js';
import { handleClassHierarchy } from './handlers/class-hierarchy.js';
import { handleSmartReadMany } from './handlers/smart-read-many.js';
import { handleProjectOverview } from './handlers/project-overview.js';
import { handleNonCodeRead, isNonCodeStructured } from './handlers/non-code.js';
import { handleExportAstIndex } from './handlers/export-ast-index.js';
import { detectContextMode } from './integration/context-mode-detector.js';
import type { ContextModeStatus } from './integration/context-mode-detector.js';
import { estimateTokens } from './core/token-estimator.js';
import {
  validateSmartReadArgs,
  validateReadSymbolArgs,
  validateReadRangeArgs,
  validateReadDiffArgs,
  validateSearchCodeArgs,
  validateFindUsagesArgs,
  validateFindImplementationsArgs,
  validateClassHierarchyArgs,
  validateSmartReadManyArgs,
  validateExportAstIndexArgs,
} from './core/validation.js';

export async function createServer(projectRoot: string) {
  const config = await loadConfig(projectRoot);
  const astIndex = new AstIndexClient(projectRoot, config.astIndex.timeout, {
    binaryPath: config.astIndex.binaryPath,
    autoInstall: true,
  });
  const fileCache = new FileCache(config.cache.maxSizeMB, config.smartRead.smallFileThreshold);
  const contextRegistry = new ContextRegistry();
  const symbolResolver = new SymbolResolver(astIndex);

  // Try to init ast-index (non-fatal if not available)
  try {
    await astIndex.init();
    if (config.astIndex.buildOnStart) {
      await astIndex.ensureIndex();
    }
  } catch (err) {
    console.error(`[token-pilot] ast-index init warning: ${err instanceof Error ? err.message : err}`);
  }

  // Session analytics
  const analytics = new SessionAnalytics();

  // Detect context-mode companion
  const cmEnabled = config.contextMode.enabled;
  const contextModeStatus: ContextModeStatus = await detectContextMode(
    projectRoot,
    cmEnabled === 'auto' ? undefined : cmEnabled,
  );
  if (contextModeStatus.detected) {
    console.error(`[token-pilot] context-mode detected (source: ${contextModeStatus.source})`);
  }
  analytics.setContextModeStatus(contextModeStatus);

  // Git watcher (selective cache invalidation on branch switch)
  const gitWatcher = new GitWatcher(projectRoot, fileCache, contextRegistry, config.git.watchHead);
  try {
    await gitWatcher.start();
  } catch (err) {
    console.error(`[token-pilot] git watcher warning: ${err instanceof Error ? err.message : err}`);
  }

  // File watcher (auto-invalidate cache on file changes)
  // Watches only files that have been loaded — NOT the entire project root
  let fileWatcher: FileWatcher | null = null;
  if (config.cache.watchFiles) {
    fileWatcher = new FileWatcher(projectRoot, fileCache, contextRegistry, config.ignore);
    fileWatcher.start();
    fileCache.onSet((filePath) => fileWatcher?.watchFile(filePath));
  }

  // Read version from package.json
  let pkgVersion = '0.1.1';
  try {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkgVersion = pkg.version;
  } catch { /* fallback to hardcoded */ }

  const server = new Server(
    { name: 'token-pilot', version: pkgVersion },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      // --- Phase 1: Core reading tools ---
      {
        name: 'smart_read',
        description: 'Read a file as a structural overview (AST-based). Returns classes, functions, methods with signatures and line ranges instead of full content. PREFERRED over Read for files > 80 lines — saves 80-95% tokens.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (absolute or relative to project root)' },
            show_imports: { type: 'boolean', description: 'Include import details (default: true)' },
            show_docs: { type: 'boolean', description: 'Include doc comments (default: true)' },
            depth: { type: 'number', description: 'Max depth for nested symbols (default: 2)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'read_symbol',
        description: 'Read the source code of a specific symbol (function, method, class). Use after smart_read to load only the code you need.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path' },
            symbol: { type: 'string', description: 'Symbol name, e.g. "UserService.updateUser"' },
            context_before: { type: 'number', description: 'Lines of context before (default: 2)' },
            context_after: { type: 'number', description: 'Lines of context after (default: 0)' },
          },
          required: ['path', 'symbol'],
        },
      },
      {
        name: 'read_range',
        description: 'Read a specific line range from a file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path' },
            start_line: { type: 'number', description: 'Start line (1-indexed)' },
            end_line: { type: 'number', description: 'End line (1-indexed, inclusive)' },
          },
          required: ['path', 'start_line', 'end_line'],
        },
      },
      {
        name: 'read_diff',
        description: 'Show only what changed in a file since Token Pilot last served it. Saves 80-95% tokens on re-reads after edits.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path' },
            context_lines: { type: 'number', description: 'Lines of context around changes (default: 3)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'smart_read_many',
        description: 'Batch smart_read for multiple files. Returns structural overview for each file in one call. Max 20 files.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of file paths',
            },
          },
          required: ['paths'],
        },
      },
      // --- Phase 2: Search & navigation ---
      {
        name: 'search_code',
        description: 'Indexed structural code search. Searches symbols and code using ast-index. Much faster and more accurate than grep for finding functions, classes, and variables.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query (symbol name, pattern)' },
            in_file: { type: 'string', description: 'Filter results to a specific file path' },
            max_results: { type: 'number', description: 'Max results (default: 20)' },
            fuzzy: { type: 'boolean', description: 'Enable fuzzy matching (default: false)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'find_usages',
        description: 'Find all usages of a symbol across the project. Groups results by: definitions, calls, imports, references.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            symbol: { type: 'string', description: 'Symbol name to find usages of' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'find_implementations',
        description: 'Find all implementations of an interface/abstract class/trait.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Interface/abstract class name' },
          },
          required: ['name'],
        },
      },
      {
        name: 'class_hierarchy',
        description: 'Show class/interface inheritance hierarchy tree.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'Class or interface name' },
          },
          required: ['name'],
        },
      },
      {
        name: 'project_overview',
        description: 'Show a compact project overview: project info, type, and structure map.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      // --- Integration ---
      {
        name: 'export_ast_index',
        description: 'Export AST structural data for cross-tool indexing. Outputs markdown or JSON that can be passed to context-mode\'s index() for BM25-searchable code structure. Use after smart_read to make code structure available via context-mode search.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific file paths to export (default: all cached files)',
            },
            format: {
              type: 'string',
              enum: ['markdown', 'json'],
              description: 'Output format: "markdown" (default, best for BM25) or "json"',
            },
          },
        },
      },
      // --- Context management & analytics ---
      {
        name: 'session_analytics',
        description: 'Show token savings report for this session: total tokens saved, per-tool breakdown, top files by savings.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'context_status',
        description: 'Show what files/symbols are currently tracked in context.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Show details for a specific file (optional)' },
          },
        },
      },
      {
        name: 'forget',
        description: 'Remove a file or symbol from context tracking.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path to forget' },
            symbol: { type: 'string', description: 'Specific symbol to forget' },
            all: { type: 'boolean', description: 'Forget everything' },
          },
        },
      },
    ],
  }));

  // Handle tool calls with validated arguments
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'smart_read': {
          const validArgs = validateSmartReadArgs(args);

          // Try non-code handler for JSON/YAML/MD etc.
          if (isNonCodeStructured(validArgs.path)) {
            const nonCodeResult = await handleNonCodeRead(validArgs.path, projectRoot, contextRegistry, {
              contextModeStatus,
              largeNonCodeThreshold: config.contextMode.largeNonCodeThreshold,
              adviseDelegation: config.contextMode.adviseDelegation,
            });
            if (nonCodeResult) {
              const text = nonCodeResult.content[0]?.text ?? '';
              analytics.record({ tool: 'smart_read', path: validArgs.path, tokensReturned: estimateTokens(text), tokensWouldBe: estimateTokens(text), timestamp: Date.now() });
              return nonCodeResult;
            }
          }

          const result = await handleSmartRead(validArgs, projectRoot, astIndex, fileCache, contextRegistry, config);
          let text = result.content[0]?.text ?? '';

          // Cross-index hint when context-mode is active
          if (contextModeStatus.detected && config.contextMode.adviseDelegation) {
            text += '\nCROSS-INDEX: Use export_ast_index to make this structure searchable via context-mode.';
            result.content[0] = { type: 'text', text };
          }

          analytics.record({ tool: 'smart_read', path: validArgs.path, tokensReturned: estimateTokens(text), tokensWouldBe: estimateTokens(text) * 5, timestamp: Date.now() });
          return result;
        }

        case 'read_symbol': {
          const symArgs = validateReadSymbolArgs(args);
          const symResult = await handleReadSymbol(symArgs, projectRoot, symbolResolver, fileCache, contextRegistry);
          const symText = symResult.content[0]?.text ?? '';
          const symTokens = estimateTokens(symText);
          analytics.record({ tool: 'read_symbol', path: symArgs.path, tokensReturned: symTokens, tokensWouldBe: symTokens * 3, timestamp: Date.now() });
          return symResult;
        }

        case 'read_range': {
          const rangeArgs = validateReadRangeArgs(args);
          const rangeResult = await handleReadRange(rangeArgs, projectRoot, fileCache, contextRegistry);
          const rangeText = rangeResult.content[0]?.text ?? '';
          const rangeTokens = estimateTokens(rangeText);
          analytics.record({ tool: 'read_range', path: rangeArgs.path, tokensReturned: rangeTokens, tokensWouldBe: rangeTokens * 3, timestamp: Date.now() });
          return rangeResult;
        }

        case 'read_diff': {
          const diffArgs = validateReadDiffArgs(args);
          const diffResult = await handleReadDiff(diffArgs, projectRoot, fileCache, contextRegistry);
          const diffText = diffResult.content[0]?.text ?? '';
          const diffTokens = estimateTokens(diffText);
          analytics.record({ tool: 'read_diff', path: diffArgs.path, tokensReturned: diffTokens, tokensWouldBe: diffTokens * 5, timestamp: Date.now() });
          return diffResult;
        }

        case 'smart_read_many': {
          const manyArgs = validateSmartReadManyArgs(args);
          const manyResult = await handleSmartReadMany(manyArgs, projectRoot, astIndex, fileCache, contextRegistry, config);
          const manyText = manyResult.content[0]?.text ?? '';
          const manyTokens = estimateTokens(manyText);
          analytics.record({ tool: 'smart_read_many', path: manyArgs.paths.join(', '), tokensReturned: manyTokens, tokensWouldBe: manyTokens * 5, timestamp: Date.now() });
          return manyResult;
        }

        case 'search_code': {
          const searchArgs = validateSearchCodeArgs(args);
          const searchResult = await handleSearchCode(searchArgs, astIndex);
          let searchText = searchResult.content[0]?.text ?? '';
          if (contextModeStatus.detected && config.contextMode.adviseDelegation) {
            searchText += '\nCROSS-INDEX: Pass these results to context-mode index(source: "token-pilot-search") for persistent BM25 search.';
            searchResult.content[0] = { type: 'text', text: searchText };
          }
          analytics.record({ tool: 'search_code', path: searchArgs.query, tokensReturned: estimateTokens(searchText), tokensWouldBe: estimateTokens(searchText), timestamp: Date.now() });
          return searchResult;
        }

        case 'find_usages': {
          const usagesArgs = validateFindUsagesArgs(args);
          const usagesResult = await handleFindUsages(usagesArgs, astIndex);
          const usagesText = usagesResult.content[0]?.text ?? '';
          analytics.record({ tool: 'find_usages', path: usagesArgs.symbol, tokensReturned: estimateTokens(usagesText), tokensWouldBe: estimateTokens(usagesText), timestamp: Date.now() });
          return usagesResult;
        }

        case 'find_implementations': {
          const implArgs = validateFindImplementationsArgs(args);
          const implResult = await handleFindImplementations(implArgs, astIndex);
          const implText = implResult.content[0]?.text ?? '';
          analytics.record({ tool: 'find_implementations', path: implArgs.name, tokensReturned: estimateTokens(implText), tokensWouldBe: estimateTokens(implText), timestamp: Date.now() });
          return implResult;
        }

        case 'class_hierarchy': {
          const hierArgs = validateClassHierarchyArgs(args);
          const hierResult = await handleClassHierarchy(hierArgs, astIndex);
          const hierText = hierResult.content[0]?.text ?? '';
          analytics.record({ tool: 'class_hierarchy', path: hierArgs.name, tokensReturned: estimateTokens(hierText), tokensWouldBe: estimateTokens(hierText), timestamp: Date.now() });
          return hierResult;
        }

        case 'project_overview':
          return await handleProjectOverview(projectRoot, astIndex);

        case 'export_ast_index':
          return await handleExportAstIndex(
            validateExportAstIndexArgs(args), astIndex, fileCache
          );

        case 'session_analytics':
          return { content: [{ type: 'text', text: analytics.report() }] };

        case 'context_status':
          return handleContextStatus(contextRegistry, args as { path?: string } | undefined);

        case 'forget':
          return handleForget(contextRegistry, args as { path?: string; symbol?: string; all?: boolean } | undefined);

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

function handleContextStatus(
  registry: ContextRegistry,
  args?: { path?: string },
): { content: Array<{ type: 'text'; text: string }> } {
  const summary = registry.summary();

  const lines: string[] = [
    `CONTEXT STATUS (session: ${formatDuration(summary.sessionDuration)})`,
    '',
    `Files tracked: ${summary.files}`,
    `Total tokens in context: ~${summary.totalTokens}`,
    '',
  ];

  for (const entry of summary.entries) {
    if (args?.path && !entry.path.includes(args.path)) continue;

    lines.push(`  ${entry.path}:`);
    for (const region of entry.loaded) {
      const label = region.symbolName ?? region.type;
      const elapsed = formatDuration(Date.now() - entry.loadedAt);
      lines.push(`    - ${label} (${region.tokens} tokens) — loaded ${elapsed} ago`);
    }
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleForget(
  registry: ContextRegistry,
  args?: { path?: string; symbol?: string; all?: boolean },
): { content: Array<{ type: 'text'; text: string }> } {
  if (args?.all) {
    registry.forgetAll();
    return { content: [{ type: 'text', text: 'Forgot all tracked content.' }] };
  }

  if (args?.path) {
    registry.forget(args.path, args.symbol);
    const what = args.symbol ? `${args.symbol} from ${args.path}` : args.path;
    return { content: [{ type: 'text', text: `Forgot: ${what}` }] };
  }

  return { content: [{ type: 'text', text: 'Specify path, symbol, or all=true.' }] };
}
