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
import { handleCodeAudit } from './handlers/code-audit.js';
import { handleModuleInfo } from './handlers/module-info.js';
import { handleSmartDiff } from './handlers/smart-diff.js';
import { handleExploreArea } from './handlers/explore-area.js';
import { handleSmartLog } from './handlers/smart-log.js';
import { handleTestSummary } from './handlers/test-summary.js';
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
  validateCodeAuditArgs,
  validateProjectOverviewArgs,
  validateModuleInfoArgs,
  validateSmartDiffArgs,
  validateExploreAreaArgs,
  validateSmartLogArgs,
  validateTestSummaryArgs,
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
    fileWatcher = new FileWatcher(projectRoot, fileCache, contextRegistry, config.ignore, astIndex);
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
        '• Verifying edits → read_diff (only changed hunks). IMPORTANT: call smart_read BEFORE editing to create baseline.',
        '• Finding symbol references → find_usages (semantic, grouped by type)',
        '• Understanding file relationships → related_files (imports, dependents, tests)',
        '• New codebase → project_overview first',
        '• Reading file again → smart_read (returns compact reminder, not full content)',
        '• Multiple files → smart_read_many (batch, max 20)',
        '• Code quality audit → code_audit (TODOs, deprecated, structural code patterns)',
        '• Reviewing git changes → smart_diff (structural diff with symbol mapping, not raw patch)',
        '• Starting work on an area → explore_area (outline + imports + tests + git log in one call)',
        '• Understanding commit history → smart_log (structured git log with categories, not raw output)',
        '• Running tests → test_summary (structured pass/fail summary, not 200 lines of raw output)',
        '',
        'WHEN TO USE DEFAULT TOOLS (Token Pilot adds no value):',
        '• Small files (≤200 lines) → smart_read returns full content anyway, same as Read',
        '• Regex text search (e.g. TODO.*fix) → use Grep/ripgrep',
        '• Counting occurrences (e.g. how many `any` types?) → use Grep count mode',
        '• Finding code duplication → use Grep to search for repeated patterns',
        '• Non-code files (JSON, YAML, Markdown, configs) → smart_read handles these but default Read works too',
        '• You need exact raw content for copy-paste → use Read',
        '',
        'COMBINE BOTH for audits and code review:',
        '• Structure/navigation → Token Pilot (project_overview, outline, smart_read)',
        '• Dead code detection → find_unused (finds unreferenced symbols)',
        '• Code issues → code_audit (TODOs, deprecated, structural patterns like bare except:)',
        '• Text pattern search/counting → Grep (regex, count mode)',
        '• Security audit → Grep for: password, token, secret, credential, hardcoded, api_key, TODO.*security',
        '• Deep dive into specific code → read_symbol (after finding issues)',
        '• Module architecture → module_info (deps, dependents, public API, unused deps)',
        '',
        'WORKFLOW: project_overview → explore_area → smart_read → read_symbol → read_for_edit → edit → smart_diff',
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
        description: 'Use INSTEAD OF re-reading whole file after edits. Shows only changed hunks. REQUIRES: call smart_read or read_for_edit BEFORE editing to create baseline snapshot.',
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
        description: 'Use INSTEAD OF Grep/ripgrep for finding symbol references. Semantic search across the project — groups results by: definitions, imports, usages. (v1.1: added scope, kind, limit, lang filters)',
        inputSchema: {
          type: 'object' as const,
          properties: {
            symbol: { type: 'string', description: 'Symbol name to find usages of' },
            scope: { type: 'string', description: 'Filter results by path prefix (e.g., "src/Domain/")' },
            kind: { type: 'string', enum: ['definitions', 'imports', 'usages', 'all'], description: 'Show only specific section (default: "all")' },
            limit: { type: 'number', description: 'Max results per category (default: 50, max: 500)' },
            lang: { type: 'string', description: 'Filter by language/extension (e.g., "php", "typescript")' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'project_overview',
        description: 'START HERE for unfamiliar codebases. Shows project type (dual-detection: ast-index + config files), architecture, framework detection, quality tools, CI, directory map. (v1.1: added include filter)',
        inputSchema: {
          type: 'object' as const,
          properties: {
            include: {
              type: 'array',
              items: { type: 'string', enum: ['stack', 'ci', 'quality', 'architecture'] },
              description: 'Sections to include (default: all). Use ["stack"] for quick type check, ["quality","ci"] for tooling overview.',
            },
          },
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
        description: 'Use INSTEAD OF listing dir + reading each file. One call returns all symbols (classes, functions, methods, routes) for every code file in a directory. (v1.1: added recursive, max_depth)',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path' },
            recursive: { type: 'boolean', description: 'Recursively outline subdirectories (default: false)' },
            max_depth: { type: 'number', description: 'Max recursion depth when recursive=true (default: 2, max: 5)' },
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
      {
        name: 'code_audit',
        description: 'Find code quality issues: TODO/FIXME comments, deprecated symbols, structural code patterns (bare except:, print() calls). Use for project-wide audits.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            check: {
              type: 'string',
              enum: ['pattern', 'todo', 'deprecated', 'annotations', 'all'],
              description: 'What to check: "pattern" (structural search via ast-grep, e.g. "except:", "print($$$ARGS)"), "todo" (TODO/FIXME comments), "deprecated" (deprecated symbols), "annotations" (find by decorator name), "all" (todo + deprecated summary)',
            },
            pattern: { type: 'string', description: 'Code pattern for check="pattern". ast-grep syntax: "except:" finds bare excepts, "print($$$ARGS)" finds print calls.' },
            name: { type: 'string', description: 'Decorator/annotation name for check="annotations". Example: "Deprecated", "Controller"' },
            lang: { type: 'string', description: 'Language filter for check="pattern" (e.g., "python", "typescript")' },
            limit: { type: 'number', description: 'Max results (default: 50)' },
          },
          required: ['check'],
        },
      },
      {
        name: 'module_info',
        description: 'Analyze module dependencies, dependents, public API, and unused deps. Use for architecture understanding and dependency cleanup.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            module: { type: 'string', description: 'Module name or path pattern (e.g., "auth", "src/Domain/")' },
            check: {
              type: 'string',
              enum: ['deps', 'dependents', 'api', 'unused-deps', 'all'],
              description: 'What to check: "deps" (dependencies), "dependents" (who depends on this), "api" (public symbols), "unused-deps" (dead dependencies), "all" (everything). Default: "all"',
            },
          },
          required: ['module'],
        },
      },
      // --- Diff & exploration ---
      {
        name: 'smart_diff',
        description: 'Use INSTEAD OF raw git diff. Shows changed files with AST symbol mapping — which functions/classes were modified/added/removed. Small diffs include hunks, large diffs show summary.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            scope: { type: 'string', enum: ['unstaged', 'staged', 'commit', 'branch'], description: 'Diff scope (default: "unstaged")' },
            path: { type: 'string', description: 'Filter to specific file or directory' },
            ref: { type: 'string', description: 'Git ref — required for scope="commit" (commit hash) or scope="branch" (branch name)' },
          },
        },
      },
      {
        name: 'explore_area',
        description: 'One-call exploration of a directory: outline (all symbols), imports (external deps + who imports this area), tests (matching test files), recent git changes. Use INSTEAD OF separate outline + related_files + git log calls.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path (or file path — will use its parent directory)' },
            include: {
              type: 'array',
              items: { type: 'string', enum: ['outline', 'imports', 'tests', 'changes'] },
              description: 'Sections to include (default: all)',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'smart_log',
        description: 'Use INSTEAD OF raw git log. Structured commit history with category detection (feat/fix/refactor/docs), file stats, author breakdown. Filters by path and ref.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Filter to specific file or directory' },
            count: { type: 'number', description: 'Number of commits (default: 10, max: 50)' },
            ref: { type: 'string', description: 'Git ref — branch, tag, or commit (default: HEAD)' },
          },
        },
      },
      {
        name: 'test_summary',
        description: 'Run tests and return structured summary: total/passed/failed/skipped + failure details. 200 lines of raw output → 10-15 lines. Supports vitest, jest, pytest, phpunit, go test, cargo test.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            command: { type: 'string', description: 'Test command to run (e.g., "npm test", "pytest", "go test ./...")' },
            runner: { type: 'string', enum: ['vitest', 'jest', 'pytest', 'phpunit', 'go', 'cargo', 'rspec', 'mocha'], description: 'Force specific parser (auto-detected if omitted)' },
            timeout: { type: 'number', description: 'Timeout in ms (default: 60000, max: 300000)' },
          },
          required: ['command'],
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
          const overviewArgs = validateProjectOverviewArgs(args);
          const overviewResult = await handleProjectOverview(overviewArgs, projectRoot, astIndex);
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

        case 'code_audit': {
          const auditArgs = validateCodeAuditArgs(args);
          const auditResult = await handleCodeAudit(auditArgs, projectRoot, astIndex);
          const auditText = auditResult.content[0]?.text ?? '';
          analytics.record({ tool: 'code_audit', path: auditArgs.check, tokensReturned: estimateTokens(auditText), tokensWouldBe: estimateTokens(auditText), timestamp: Date.now() });
          return auditResult;
        }

        case 'module_info': {
          const moduleArgs = validateModuleInfoArgs(args);
          const moduleResult = await handleModuleInfo(moduleArgs, projectRoot, astIndex);
          const moduleText = moduleResult.content[0]?.text ?? '';
          // Estimate: manual analysis would require reading all module files + grepping deps
          const moduleWouldBe = estimateTokens(moduleText) * 5;
          analytics.record({ tool: 'module_info', path: moduleArgs.module, tokensReturned: estimateTokens(moduleText), tokensWouldBe: moduleWouldBe, timestamp: Date.now() });
          return moduleResult;
        }

        case 'smart_diff': {
          const sdArgs = validateSmartDiffArgs(args);
          const sdResult = await handleSmartDiff(sdArgs, projectRoot, astIndex);
          const sdText = sdResult.content[0]?.text ?? '';
          const sdTokens = estimateTokens(sdText);
          analytics.record({ tool: 'smart_diff', path: sdArgs.path ?? sdArgs.scope ?? 'unstaged', tokensReturned: sdTokens, tokensWouldBe: sdResult.rawTokens || sdTokens, timestamp: Date.now() });
          return { content: sdResult.content };
        }

        case 'explore_area': {
          const eaArgs = validateExploreAreaArgs(args);
          const eaResult = await handleExploreArea(eaArgs, projectRoot, astIndex);
          const eaText = eaResult.content[0]?.text ?? '';
          const eaTokens = estimateTokens(eaText);
          // Without explore_area, agent would call: outline + related_files + git log = ~3-5x tokens
          const eaWouldBe = eaTokens * 4;
          analytics.record({ tool: 'explore_area', path: eaArgs.path, tokensReturned: eaTokens, tokensWouldBe: eaWouldBe, timestamp: Date.now() });
          return eaResult;
        }

        case 'smart_log': {
          const slArgs = validateSmartLogArgs(args);
          const slResult = await handleSmartLog(slArgs, projectRoot);
          const slText = slResult.content[0]?.text ?? '';
          const slTokens = estimateTokens(slText);
          analytics.record({ tool: 'smart_log', path: slArgs.path ?? 'all', tokensReturned: slTokens, tokensWouldBe: slResult.rawTokens || slTokens, timestamp: Date.now() });
          return { content: slResult.content };
        }

        case 'test_summary': {
          const tsArgs = validateTestSummaryArgs(args);
          const tsResult = await handleTestSummary(tsArgs, projectRoot);
          const tsText = tsResult.content[0]?.text ?? '';
          const tsTokens = estimateTokens(tsText);
          analytics.record({ tool: 'test_summary', path: tsArgs.command, tokensReturned: tsTokens, tokensWouldBe: tsResult.rawTokens || tsTokens, timestamp: Date.now() });
          return { content: tsResult.content };
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
