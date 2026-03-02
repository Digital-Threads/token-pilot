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

import { loadConfig } from './config/loader.js';
import { readFileSync } from 'node:fs';
import { GitWatcher } from './git/watcher.js';
import { FileWatcher } from './git/file-watcher.js';
import { handleSmartRead } from './handlers/smart-read.js';
import { handleReadSymbol } from './handlers/read-symbol.js';
import { handleReadRange } from './handlers/read-range.js';
import { handleReadDiff } from './handlers/read-diff.js';
import { handleFindUsages } from './handlers/find-usages.js';
import { handleSmartReadMany } from './handlers/smart-read-many.js';
import { handleProjectOverview } from './handlers/project-overview.js';
import { handleNonCodeRead, isNonCodeStructured } from './handlers/non-code.js';
import { handleFindUnused } from './handlers/find-unused.js';
import { handleReadForEdit } from './handlers/read-for-edit.js';
import { handleRelatedFiles } from './handlers/related-files.js';
import { handleOutline } from './handlers/outline.js';
import { detectContextMode } from './integration/context-mode-detector.js';
import type { ContextModeStatus } from './integration/context-mode-detector.js';
import { estimateTokens } from './core/token-estimator.js';
import {
  resolveSafePath,
  validateSmartReadArgs,
  validateReadSymbolArgs,
  validateReadRangeArgs,
  validateReadDiffArgs,
  validateFindUsagesArgs,
  validateSmartReadManyArgs,
  validateReadForEditArgs,
  validateRelatedFilesArgs,
  validateOutlineArgs,
  validateFindUnusedArgs,
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
      // --- Core reading tools (USE INSTEAD OF Read/cat) ---
      {
        name: 'smart_read',
        description: 'ALWAYS use instead of Read/cat for code files. Returns AST structural overview: classes, functions, methods with signatures and line ranges. Saves 80-99% tokens. After reading structure, use read_symbol() to load specific functions.',
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
        description: 'Read source code of a specific function/method/class. Use after smart_read() — loads only the code you need instead of the entire file. Supports Class.method syntax.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path' },
            symbol: { type: 'string', description: 'Symbol name, e.g. "UserService.updateUser"' },
            context_before: { type: 'number', description: 'Lines of context before (default: 2)' },
            context_after: { type: 'number', description: 'Lines of context after (default: 0)' },
            show: { type: 'string', enum: ['full', 'head', 'tail', 'outline'], description: 'Display mode: full (all lines), head (first 50), tail (last 30), outline (head + methods + tail). Default: auto (full ≤300 lines, outline >300)' },
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
        description: 'After editing a file, use this instead of re-reading it. Shows only changed hunks since last smart_read. Saves 80-95% tokens on re-reads.',
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
        name: 'read_for_edit',
        description: 'Get minimal code context for editing. Returns RAW source (no line numbers) around a symbol or line — copy directly as old_string for Edit tool. 97% fewer tokens than reading full file before editing.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path' },
            symbol: { type: 'string', description: 'Symbol name to edit (e.g. "UserService.updateUser")' },
            line: { type: 'number', description: 'Line number to edit (alternative to symbol)' },
            context: { type: 'number', description: 'Lines of context around target (default: 5)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'smart_read_many',
        description: 'Read multiple files at once. Returns AST structural overview for each file in one call. ALWAYS use instead of multiple Read calls. Max 20 files.',
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
      // --- Search & navigation ---
      {
        name: 'find_usages',
        description: 'Find all usages of a symbol across the project. Use instead of Grep for symbol references. Groups by: definitions, imports, usages.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            symbol: { type: 'string', description: 'Symbol name to find usages of' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'project_overview',
        description: 'Start here. Shows project type, architecture, framework detection, directory structure with symbol counts. Use before exploring unfamiliar codebases.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'related_files',
        description: 'Show import graph for a file: what it imports, what imports it, and its test files. Saves 3-5 Read calls when exploring module relationships.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path to analyze' },
          },
          required: ['path'],
        },
      },
      {
        name: 'outline',
        description: 'Compact overview of all code files in a directory. One call instead of 5-6 smart_read calls. Shows classes, functions, methods, HTTP routes per file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path' },
          },
          required: ['path'],
        },
      },
      // --- Analytics ---
      {
        name: 'session_analytics',
        description: 'Show token savings report for this session: total tokens saved, per-tool breakdown, top files by savings.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      // --- Analysis ---
      {
        name: 'find_unused',
        description: 'Find potentially unused symbols in the project. Detects dead code — functions, classes, and variables with no references.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            module: { type: 'string', description: 'Filter by module path (e.g., "src/services/")' },
            export_only: { type: 'boolean', description: 'Only check exported (capitalized) symbols' },
            limit: { type: 'number', description: 'Max results (default: 30)' },
          },
        },
      },
    ],
  }));

  // Helper: get real full-file token count for honest analytics
  async function fullFileTokens(relativePath: string): Promise<number> {
    try {
      const absPath = resolveSafePath(projectRoot, relativePath);
      const cached = fileCache.get(absPath);
      if (cached) return estimateTokens(cached.content);
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(absPath, 'utf-8');
      return estimateTokens(content);
    } catch {
      return 0;
    }
  }

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
          const text = result.content[0]?.text ?? '';
          const fullTokensSR = await fullFileTokens(validArgs.path);
          analytics.record({ tool: 'smart_read', path: validArgs.path, tokensReturned: estimateTokens(text), tokensWouldBe: fullTokensSR || estimateTokens(text), timestamp: Date.now() });
          return result;
        }

        case 'read_symbol': {
          const symArgs = validateReadSymbolArgs(args);
          const symResult = await handleReadSymbol(symArgs, projectRoot, symbolResolver, fileCache, contextRegistry, astIndex);
          const symText = symResult.content[0]?.text ?? '';
          const symTokens = estimateTokens(symText);
          const fullTokensSym = await fullFileTokens(symArgs.path);
          analytics.record({ tool: 'read_symbol', path: symArgs.path, tokensReturned: symTokens, tokensWouldBe: fullTokensSym || symTokens, timestamp: Date.now() });
          return symResult;
        }

        case 'read_range': {
          const rangeArgs = validateReadRangeArgs(args);
          const rangeResult = await handleReadRange(rangeArgs, projectRoot, fileCache, contextRegistry);
          const rangeText = rangeResult.content[0]?.text ?? '';
          const rangeTokens = estimateTokens(rangeText);
          const fullTokensRange = await fullFileTokens(rangeArgs.path);
          analytics.record({ tool: 'read_range', path: rangeArgs.path, tokensReturned: rangeTokens, tokensWouldBe: fullTokensRange || rangeTokens, timestamp: Date.now() });
          return rangeResult;
        }

        case 'read_diff': {
          const diffArgs = validateReadDiffArgs(args);
          const diffResult = await handleReadDiff(diffArgs, projectRoot, fileCache, contextRegistry);
          const diffText = diffResult.content[0]?.text ?? '';
          const diffTokens = estimateTokens(diffText);
          const fullTokensDiff = await fullFileTokens(diffArgs.path);
          analytics.record({ tool: 'read_diff', path: diffArgs.path, tokensReturned: diffTokens, tokensWouldBe: fullTokensDiff || diffTokens, timestamp: Date.now() });
          return diffResult;
        }

        case 'read_for_edit': {
          const editArgs = validateReadForEditArgs(args);
          const editResult = await handleReadForEdit(editArgs, projectRoot, symbolResolver, fileCache, contextRegistry, astIndex);
          const editText = editResult.content[0]?.text ?? '';
          const editTokens = estimateTokens(editText);
          const fullTokensEdit = await fullFileTokens(editArgs.path);
          analytics.record({ tool: 'read_for_edit', path: editArgs.path, tokensReturned: editTokens, tokensWouldBe: fullTokensEdit || editTokens, timestamp: Date.now() });
          return editResult;
        }

        case 'smart_read_many': {
          const manyArgs = validateSmartReadManyArgs(args);
          const manyResult = await handleSmartReadMany(manyArgs, projectRoot, astIndex, fileCache, contextRegistry, config);
          const manyText = manyResult.content[0]?.text ?? '';
          const manyTokens = estimateTokens(manyText);
          let fullTokensMany = 0;
          for (const p of manyArgs.paths) { fullTokensMany += await fullFileTokens(p); }
          analytics.record({ tool: 'smart_read_many', path: manyArgs.paths.join(', '), tokensReturned: manyTokens, tokensWouldBe: fullTokensMany || manyTokens, timestamp: Date.now() });
          return manyResult;
        }

        case 'find_usages': {
          const usagesArgs = validateFindUsagesArgs(args);
          const usagesResult = await handleFindUsages(usagesArgs, astIndex);
          const usagesText = usagesResult.content[0]?.text ?? '';
          analytics.record({ tool: 'find_usages', path: usagesArgs.symbol, tokensReturned: estimateTokens(usagesText), tokensWouldBe: estimateTokens(usagesText), timestamp: Date.now() });
          return usagesResult;
        }

        case 'project_overview': {
          const overviewResult = await handleProjectOverview(projectRoot, astIndex);
          const overviewText = overviewResult.content[0]?.text ?? '';
          overviewResult.content[0] = { type: 'text', text: `TOKEN PILOT v${pkgVersion}\n\n${overviewText}` };
          return overviewResult;
        }

        case 'related_files': {
          const relArgs = validateRelatedFilesArgs(args);
          const relResult = await handleRelatedFiles(relArgs, projectRoot, astIndex);
          const relText = relResult.content[0]?.text ?? '';
          analytics.record({ tool: 'related_files', path: relArgs.path, tokensReturned: estimateTokens(relText), tokensWouldBe: estimateTokens(relText), timestamp: Date.now() });
          return relResult;
        }

        case 'outline': {
          const outlineArgs = validateOutlineArgs(args);
          const outlineResult = await handleOutline(outlineArgs, projectRoot, astIndex);
          const outlineText = outlineResult.content[0]?.text ?? '';
          analytics.record({ tool: 'outline', path: outlineArgs.path, tokensReturned: estimateTokens(outlineText), tokensWouldBe: estimateTokens(outlineText), timestamp: Date.now() });
          return outlineResult;
        }

        case 'session_analytics':
          return { content: [{ type: 'text', text: `TOKEN PILOT v${pkgVersion}\n\n${analytics.report()}` }] };

        case 'find_unused': {
          const unusedArgs = validateFindUnusedArgs(args);
          const unusedResult = await handleFindUnused(unusedArgs, astIndex);
          const unusedText = unusedResult.content[0]?.text ?? '';
          analytics.record({ tool: 'find_unused', path: unusedArgs.module ?? 'all', tokensReturned: estimateTokens(unusedText), tokensWouldBe: estimateTokens(unusedText), timestamp: Date.now() });
          return unusedResult;
        }

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
