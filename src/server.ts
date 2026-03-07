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
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { isDangerousRoot } from './core/validation.js';
import { promisify } from 'node:util';
import { GitWatcher } from './git/watcher.js';

const execFilePromise = promisify(execFile);
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

export async function createServer(projectRoot: string, options?: { skipAstIndex?: boolean }) {
  const config = await loadConfig(projectRoot);
  const astIndex = new AstIndexClient(projectRoot, config.astIndex.timeout, {
    binaryPath: config.astIndex.binaryPath,
    autoInstall: true,
  });
  const fileCache = new FileCache(config.cache.maxSizeMB, config.smartRead.smallFileThreshold);
  const contextRegistry = new ContextRegistry();
  const symbolResolver = new SymbolResolver(astIndex);

  // Try to init ast-index (non-fatal if not available)
  const needsAutoDetect = !!options?.skipAstIndex;
  try {
    await astIndex.init(); // Always find binary — fast, harmless
    if (needsAutoDetect) {
      // Dangerous root (/, home dir) — don't build index yet
      // Will auto-detect real project root from first file path
      astIndex.disableIndex();
      console.error('[token-pilot] ast-index: waiting for first file path to auto-detect project root');
    } else if (config.astIndex.buildOnStart) {
      await astIndex.ensureIndex();
    }
  } catch (err) {
    console.error(`[token-pilot] ast-index init warning: ${err instanceof Error ? err.message : err}`);
  }

  // Auto-detect project root (when startup root was dangerous like /)
  // Strategy 1: MCP roots from client (Claude Code sends workspace root)
  // Strategy 2: Git detect from file path in tool args
  let autoDetectDone = false;

  async function applyDetectedRoot(rootPath: string, source: string): Promise<void> {
    projectRoot = rootPath;
    astIndex.updateProjectRoot(rootPath);
    astIndex.enableIndex();
    console.error(`[token-pilot] project root: ${rootPath} (${source})`);
    try {
      await astIndex.ensureIndex();
    } catch (e) {
      console.error(`[token-pilot] ast-index build: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function tryAutoDetectRoot(filePath?: string): Promise<void> {
    if (autoDetectDone || !needsAutoDetect) return;
    autoDetectDone = true; // Only try once

    // Strategy 1: MCP roots — client tells us the workspace root
    try {
      const caps = server.getClientCapabilities();
      if (caps?.roots) {
        const { roots } = await server.listRoots();
        for (const root of roots) {
          if (root.uri.startsWith('file://')) {
            const rootPath = decodeURIComponent(new URL(root.uri).pathname);
            if (rootPath && !isDangerousRoot(rootPath)) {
              await applyDetectedRoot(rootPath, 'MCP roots');
              return;
            }
          }
        }
      }
    } catch {
      // Client doesn't support roots or request failed — try next strategy
    }

    // Strategy 2: Git detect from file path in tool call args
    if (filePath) {
      const dir = dirname(filePath);
      try {
        const { stdout } = await execFilePromise('git', ['rev-parse', '--show-toplevel'], {
          cwd: dir,
          timeout: 3000,
        });
        const gitRoot = stdout.trim();
        if (gitRoot && !isDangerousRoot(gitRoot)) {
          await applyDetectedRoot(gitRoot, `git from ${filePath}`);
          return;
        }
      } catch {
        console.error(`[token-pilot] auto-detect failed for ${dir} — not a git repo`);
      }
    }
  }

  /**
   * Extract any absolute file path from tool call arguments.
   */
  function extractFilePath(toolArgs: Record<string, unknown>): string | undefined {
    const path = toolArgs?.path as string | undefined;
    if (path && typeof path === 'string' && path.startsWith('/')) return path;

    const paths = toolArgs?.paths as string[] | undefined;
    if (paths?.[0] && typeof paths[0] === 'string' && paths[0].startsWith('/')) return paths[0];

    const file = toolArgs?.file as string | undefined;
    if (file && typeof file === 'string' && file.startsWith('/')) return file;

    const mod = toolArgs?.module as string | undefined;
    if (mod && typeof mod === 'string' && mod.startsWith('/')) return mod;

    return undefined;
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
    {
      capabilities: { tools: {} },
      instructions: [
        'Token Pilot provides token-efficient code reading. Use these rules:',
        '',
        'WHEN TO USE TOKEN PILOT (saves 60-80% tokens):',
        '• Reading code files → smart_read (returns structure, not raw content)',
        '• Need one function/class → read_symbol (loads only that symbol)',
        '• Exploring a directory → outline (all symbols in one call)',
        '• Preparing an edit → read_for_edit (exact text for Edit old_string)',
        '• Verifying edits → read_diff (only changed hunks, not whole file)',
        '• Finding symbol references → find_usages (semantic, grouped by type)',
        '• Understanding file relationships → related_files (imports, dependents, tests)',
        '• New codebase → project_overview first',
        '• Reading file again → smart_read (returns compact reminder, not full content)',
        '• Multiple files → smart_read_many (batch, max 20)',
        '',
        'WHEN TO USE DEFAULT TOOLS (Token Pilot adds no value):',
        '• Regex/pattern search (e.g. TODO.*fix) → use Grep/ripgrep, NOT find_usages',
        '• Non-code files (JSON, YAML, Markdown, configs) → smart_read handles these but default Read works too',
        '• You need exact raw content for copy-paste → use Read',
        '',
        'WORKFLOW: project_overview → smart_read → read_symbol → read_for_edit → edit → read_diff',
      ].join('\n'),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      // --- Core reading tools ---
      {
        name: 'smart_read',
        description: 'Use INSTEAD OF Read/cat for code files. Returns code structure (classes, functions, methods with signatures and line ranges) — 60-80% fewer tokens than raw content. Use read_symbol() to drill into specific code.',
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
        description: 'Read source code of ONE specific function/method/class — INSTEAD OF reading the whole file. Supports Class.method syntax.',
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
        description: 'Use INSTEAD OF re-reading whole file after edits. Shows only changed hunks since last smart_read — saves tokens by not re-reading unchanged code.',
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
        description: 'Use INSTEAD OF Read when preparing an edit. Returns exact raw code around a symbol or line — copy directly as old_string for Edit tool.',
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
        description: 'Batch smart_read for multiple files at once — INSTEAD OF calling Read on each file. Returns structure for each file. Max 20 files.',
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
        description: 'Use INSTEAD OF Grep/ripgrep for finding symbol references. Semantic search across the project — groups results by: definitions, imports, usages.',
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
        description: 'START HERE for unfamiliar codebases. Shows project type, architecture, framework detection, directory structure with symbol counts. Use before exploring code.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'related_files',
        description: 'Show import graph for a file: what it imports, what imports it, and test files. Understand dependencies before refactoring.',
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
        description: 'Use INSTEAD OF listing dir + reading each file. One call returns all symbols (classes, functions, methods, routes) for every code file in a directory.',
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
        description: 'Find dead code — functions, classes, and variables with no references across the project. Use for cleanup and refactoring.',
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
      const { readFile: readFileAsync } = await import('node:fs/promises');
      const content = await readFileAsync(absPath, 'utf-8');
      return estimateTokens(content);
    } catch {
      return 0;
    }
  }

  // Handle tool calls with validated arguments
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Auto-detect project root on first tool call (when startup root was /)
    // Tries: MCP roots → git detect from file path in args
    if (needsAutoDetect && !autoDetectDone) {
      const detectedPath = extractFilePath((args ?? {}) as Record<string, unknown>);
      await tryAutoDetectRoot(detectedPath);
    }

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
          const ovTokens = estimateTokens(overviewResult.content[0].text);
          analytics.record({ tool: 'project_overview', path: projectRoot, tokensReturned: ovTokens, tokensWouldBe: ovTokens, timestamp: Date.now() });
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
