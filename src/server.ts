import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AstIndexClient } from './ast-index/client.js';
import { FileCache } from './core/file-cache.js';
import { ContextRegistry } from './core/context-registry.js';
import { SymbolResolver } from './core/symbol-resolver.js';
import { SessionAnalytics, type SavingsCategory } from './core/session-analytics.js';
import { classifyIntent } from './core/intent-classifier.js';
import { buildDecisionTrace } from './core/decision-trace.js';
import { SessionCache } from './core/session-cache.js';

import { loadConfig } from './config/loader.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { isDangerousRoot } from './core/validation.js';
import { promisify } from 'node:util';
import { GitWatcher } from './git/watcher.js';

const execFilePromise = promisify(execFile);
import { FileWatcher } from './git/file-watcher.js';
import { handleSmartRead } from './handlers/smart-read.js';
import { handleReadSymbol } from './handlers/read-symbol.js';
import { handleReadSymbols } from './handlers/read-symbols.js';
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
import { checkPolicy, isFullReadTool } from './core/policy-engine.js';
import { MCP_INSTRUCTIONS, TOOL_DEFINITIONS } from './server/tool-definitions.js';
import { createTokenEstimates } from './server/token-estimates.js';
import {
  validateSmartReadArgs,
  validateReadSymbolArgs,
  validateReadSymbolsArgs,
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
  analytics.setProjectRoot(projectRoot);

  // Session cache (tool-result-level caching, invalidated by file/AST/git changes)
  const sessionCache = config.sessionCache.enabled
    ? new SessionCache(config.sessionCache.maxEntries)
    : null;

  // Policy engine state
  let fullFileReadsCount = 0;
  const readForEditCalled = new Set<string>();

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
    if (sessionCache) {
      fileWatcher.onFileChange((absPath) => sessionCache.invalidateByFiles([absPath]));
      fileWatcher.onAstUpdate(() => sessionCache.invalidateByAst());
    }
  }

  // Wire session cache to git watcher
  if (sessionCache) {
    gitWatcher.onBranchSwitchEvent((changedFiles) => {
      sessionCache.invalidateByFiles(changedFiles);
      sessionCache.invalidateByGit();
    });
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
      instructions: MCP_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Token estimation functions (extracted to server/token-estimates.ts)
  const {
    fullFileTokens,
    estimateProjectOverviewWorkflowTokens,
    estimateOutlineWorkflowTokens,
    estimateRelatedFilesWorkflowTokens,
    estimateFindUsagesWorkflowTokens,
    estimateExploreAreaWorkflowTokens,
    detectSavingsCategory,
  } = createTokenEstimates(() => projectRoot, fileCache);

  /** Record analytics with intent classification and decision trace. Returns policy advisory if any. */
  function recordWithTrace(call: {
    tool: string;
    path?: string;
    tokensReturned: number;
    tokensWouldBe: number;
    timestamp: number;
    savingsCategory?: SavingsCategory;
    sessionCacheHit?: boolean;
    delegatedToContextMode?: boolean;
    absPath?: string;
    args?: Record<string, unknown> | object;
    recentlyEdited?: boolean;
  }): string | null {
    const { absPath, args, recentlyEdited, ...rest } = call;
    analytics.record({
      ...rest,
      intent: classifyIntent(rest.tool),
      decisionTrace: buildDecisionTrace({
        absPath,
        tool: rest.tool,
        args: (args ?? {}) as Record<string, unknown>,
        contextRegistry,
        fileCache,
        tokensReturned: rest.tokensReturned,
        tokensWouldBe: rest.tokensWouldBe,
        recentlyEdited,
      }),
    });

    // Policy tracking
    if (isFullReadTool(rest.tool)) {
      fullFileReadsCount++;
    }
    if (rest.tool === 'read_for_edit' && call.path) {
      readForEditCalled.add(call.path);
    }

    // Policy check
    const advisory = checkPolicy(config.policies, rest.tool, {
      fullFileReadsCount,
      tokensReturned: rest.tokensReturned,
      readForEditCalled,
    });

    return advisory ? `\n${advisory.message}` : null;
  }

  // Handle tool calls with validated arguments
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Auto-detect project root on first tool call (when startup root was /)
    // Tries: MCP roots → git detect from file path in args
    if (needsAutoDetect && !autoDetectDone) {
      const detectedPath = extractFilePath((args ?? {}));
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
              recordWithTrace({
                tool: 'smart_read',
                path: validArgs.path,
                tokensReturned: estimateTokens(text),
                tokensWouldBe: await fullFileTokens(validArgs.path) || estimateTokens(text),
                timestamp: Date.now(),
                delegatedToContextMode: text.includes('ADVISORY:') && text.includes('context-mode'),
                savingsCategory: 'compression',
                absPath: resolve(projectRoot, validArgs.path),
                args: validArgs,
              });
              return nonCodeResult;
            }
          }

          // Dedup is handled inside handleSmartRead (step 5)
          const result = await handleSmartRead(validArgs, projectRoot, astIndex, fileCache, contextRegistry, config);
          const text = result.content[0]?.text ?? '';
          const fullTokensSR = await fullFileTokens(validArgs.path);
          const policyAdv = recordWithTrace({ tool: 'smart_read', path: validArgs.path, tokensReturned: estimateTokens(text), tokensWouldBe: fullTokensSR || estimateTokens(text), timestamp: Date.now(), savingsCategory: detectSavingsCategory(text), absPath: resolve(projectRoot, validArgs.path), args: validArgs });
          if (policyAdv) result.content[0] = { type: 'text', text: text + policyAdv };
          return result;
        }

        case 'read_symbol': {
          const symArgs = validateReadSymbolArgs(args);

          // Dedup is handled inside handleReadSymbol
          const symResult = await handleReadSymbol(symArgs, projectRoot, symbolResolver, fileCache, contextRegistry, astIndex, config.smartRead.advisoryReminders);
          const symText = symResult.content[0]?.text ?? '';
          const symTokens = estimateTokens(symText);
          const fullTokensSym = await fullFileTokens(symArgs.path);
          recordWithTrace({ tool: 'read_symbol', path: symArgs.path, tokensReturned: symTokens, tokensWouldBe: fullTokensSym || symTokens, timestamp: Date.now(), savingsCategory: detectSavingsCategory(symText), absPath: resolve(projectRoot, symArgs.path), args: symArgs });
          return symResult;
        }

        case 'read_symbols': {
          const rsArgs = validateReadSymbolsArgs(args);
          const rsResult = await handleReadSymbols(rsArgs, projectRoot, symbolResolver, fileCache, contextRegistry, astIndex, config.smartRead.advisoryReminders);
          const rsText = rsResult.content[0]?.text ?? '';
          const rsTokens = estimateTokens(rsText);
          const fullTokensRs = await fullFileTokens(rsArgs.path);
          recordWithTrace({ tool: 'read_symbols', path: rsArgs.path, tokensReturned: rsTokens, tokensWouldBe: fullTokensRs || rsTokens, timestamp: Date.now(), savingsCategory: 'compression', absPath: resolve(projectRoot, rsArgs.path), args: rsArgs });
          return rsResult;
        }

        case 'read_range': {
          const rangeArgs = validateReadRangeArgs(args);
          const rangeResult = await handleReadRange(rangeArgs, projectRoot, fileCache, contextRegistry, config.smartRead.advisoryReminders);
          const rangeText = rangeResult.content[0]?.text ?? '';
          const rangeTokens = estimateTokens(rangeText);
          const fullTokensRange = await fullFileTokens(rangeArgs.path);
          recordWithTrace({ tool: 'read_range', path: rangeArgs.path, tokensReturned: rangeTokens, tokensWouldBe: fullTokensRange || rangeTokens, timestamp: Date.now(), savingsCategory: detectSavingsCategory(rangeText), absPath: resolve(projectRoot, rangeArgs.path), args: rangeArgs });
          return rangeResult;
        }

        case 'read_diff': {
          const diffArgs = validateReadDiffArgs(args);
          const diffResult = await handleReadDiff(diffArgs, projectRoot, fileCache, contextRegistry);
          const diffText = diffResult.content[0]?.text ?? '';
          const diffTokens = estimateTokens(diffText);
          const fullTokensDiff = await fullFileTokens(diffArgs.path);
          recordWithTrace({ tool: 'read_diff', path: diffArgs.path, tokensReturned: diffTokens, tokensWouldBe: fullTokensDiff || diffTokens, timestamp: Date.now(), savingsCategory: 'compression', absPath: resolve(projectRoot, diffArgs.path), args: diffArgs });
          return diffResult;
        }

        case 'read_for_edit': {
          const editArgs = validateReadForEditArgs(args);
          const editResult = await handleReadForEdit(editArgs, projectRoot, symbolResolver, fileCache, contextRegistry, astIndex, { actionableHints: config.display.actionableHints });
          const editText = editResult.content[0]?.text ?? '';
          const editTokens = estimateTokens(editText);
          const fullTokensEdit = await fullFileTokens(editArgs.path);
          recordWithTrace({ tool: 'read_for_edit', path: editArgs.path, tokensReturned: editTokens, tokensWouldBe: fullTokensEdit || editTokens, timestamp: Date.now(), savingsCategory: 'compression', absPath: resolve(projectRoot, editArgs.path), args: editArgs });
          return editResult;
        }

        case 'smart_read_many': {
          const manyArgs = validateSmartReadManyArgs(args);
          const manyResult = await handleSmartReadMany(manyArgs, projectRoot, astIndex, fileCache, contextRegistry, config);
          const manyText = manyResult.content[0]?.text ?? '';
          const manyTokens = estimateTokens(manyText);
          const uniqueManyPaths = Array.from(new Set(manyArgs.paths));
          let fullTokensMany = 0;
          for (const p of uniqueManyPaths) {
            fullTokensMany += await fullFileTokens(p);
          }
          recordWithTrace({
            tool: 'smart_read_many',
            path: uniqueManyPaths.join(', '),
            tokensReturned: manyTokens,
            tokensWouldBe: fullTokensMany || manyTokens,
            timestamp: Date.now(),
            savingsCategory: 'compression',
            args: manyArgs,
          });
          return manyResult;
        }

        case 'find_usages': {
          const usagesArgs = validateFindUsagesArgs(args);
          const cachedUsages = sessionCache?.get('find_usages', usagesArgs);
          if (cachedUsages) {
            recordWithTrace({ tool: 'find_usages', path: usagesArgs.symbol, tokensReturned: cachedUsages.tokenEstimate, tokensWouldBe: cachedUsages.tokensWouldBe ?? cachedUsages.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: usagesArgs });
            return cachedUsages.result;
          }
          const usagesResult = await handleFindUsages(usagesArgs, astIndex, projectRoot);
          const usagesText = usagesResult.content[0]?.text ?? '';
          const usagesTokens = estimateTokens(usagesText);
          const usagesWouldBe = await estimateFindUsagesWorkflowTokens(usagesResult.meta.files);
          sessionCache?.set('find_usages', usagesArgs, usagesResult, {
            files: usagesResult.meta.files.map(f => resolve(projectRoot, f)),
            dependsOnAst: true,
          }, usagesTokens, usagesWouldBe || usagesTokens);
          recordWithTrace({
            tool: 'find_usages',
            path: usagesArgs.symbol,
            tokensReturned: usagesTokens,
            tokensWouldBe: usagesWouldBe || usagesTokens,
            timestamp: Date.now(),
            savingsCategory: 'compression',
            args: usagesArgs,
          });
          return usagesResult;
        }

        case 'project_overview': {
          const overviewArgs = validateProjectOverviewArgs(args);
          const cachedOverview = sessionCache?.get('project_overview', overviewArgs);
          if (cachedOverview) {
            recordWithTrace({ tool: 'project_overview', path: projectRoot, tokensReturned: cachedOverview.tokenEstimate, tokensWouldBe: cachedOverview.tokensWouldBe ?? cachedOverview.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: overviewArgs });
            return cachedOverview.result;
          }
          const overviewResult = await handleProjectOverview(overviewArgs, projectRoot, astIndex, pkgVersion);
          const overviewText = overviewResult.content[0]?.text ?? '';
          overviewResult.content[0] = { type: 'text', text: `TOKEN PILOT v${pkgVersion}\n\n${overviewText}` };
          const ovTokens = estimateTokens(overviewResult.content[0].text);
          const overviewWouldBe = await estimateProjectOverviewWorkflowTokens(
            overviewArgs.include ?? ['stack', 'ci', 'quality', 'architecture'],
          );
          sessionCache?.set('project_overview', overviewArgs, overviewResult, {
            dependsOnAst: true,
          }, ovTokens, overviewWouldBe || ovTokens);
          recordWithTrace({
            tool: 'project_overview',
            path: projectRoot,
            tokensReturned: ovTokens,
            tokensWouldBe: overviewWouldBe || ovTokens,
            timestamp: Date.now(),
            savingsCategory: 'compression',
            args: overviewArgs,
          });
          return overviewResult;
        }

        case 'related_files': {
          const relArgs = validateRelatedFilesArgs(args);
          const cachedRel = sessionCache?.get('related_files', relArgs);
          if (cachedRel) {
            recordWithTrace({ tool: 'related_files', path: relArgs.path, tokensReturned: cachedRel.tokenEstimate, tokensWouldBe: cachedRel.tokensWouldBe ?? cachedRel.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', absPath: resolve(projectRoot, relArgs.path), args: relArgs });
            return cachedRel.result;
          }
          const relResult = await handleRelatedFiles(relArgs, projectRoot, astIndex);
          const relText = relResult.content[0]?.text ?? '';
          const relTokens = estimateTokens(relText);
          const relWouldBe = await estimateRelatedFilesWorkflowTokens(relArgs.path, relResult.meta);
          const relDeps = [
            resolve(projectRoot, relArgs.path),
            ...relResult.meta.imports.map(f => resolve(projectRoot, f)),
            ...relResult.meta.importedBy.map(f => resolve(projectRoot, f)),
            ...relResult.meta.tests.map(f => resolve(projectRoot, f)),
          ];
          sessionCache?.set('related_files', relArgs, relResult, {
            files: relDeps,
            dependsOnAst: true,
          }, relTokens, relWouldBe || relTokens);
          recordWithTrace({
            tool: 'related_files',
            path: relArgs.path,
            tokensReturned: relTokens,
            tokensWouldBe: relWouldBe || relTokens,
            timestamp: Date.now(),
            savingsCategory: 'compression',
            absPath: resolve(projectRoot, relArgs.path),
            args: relArgs,
          });
          return relResult;
        }

        case 'outline': {
          const outlineArgs = validateOutlineArgs(args);
          const cachedOutline = sessionCache?.get('outline', outlineArgs);
          if (cachedOutline) {
            recordWithTrace({ tool: 'outline', path: outlineArgs.path, tokensReturned: cachedOutline.tokenEstimate, tokensWouldBe: cachedOutline.tokensWouldBe ?? cachedOutline.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: outlineArgs });
            return cachedOutline.result;
          }
          const outlineResult = await handleOutline(outlineArgs, projectRoot, astIndex);
          const outlineText = outlineResult.content[0]?.text ?? '';
          const outlineTokens = estimateTokens(outlineText);
          const outlineWouldBe = await estimateOutlineWorkflowTokens(
            outlineArgs.path,
            outlineArgs.recursive ?? false,
            outlineArgs.max_depth ?? 2,
          );
          sessionCache?.set('outline', outlineArgs, outlineResult, {
            files: [resolve(projectRoot, outlineArgs.path) + '/'],
            dependsOnAst: true,
          }, outlineTokens, outlineWouldBe || outlineTokens);
          recordWithTrace({
            tool: 'outline',
            path: outlineArgs.path,
            tokensReturned: outlineTokens,
            tokensWouldBe: outlineWouldBe || outlineTokens,
            timestamp: Date.now(),
            savingsCategory: 'compression',
            args: outlineArgs,
          });
          return outlineResult;
        }

        case 'session_analytics': {
          const verbose = (args as Record<string, unknown>)?.verbose === true;
          return { content: [{ type: 'text', text: `TOKEN PILOT v${pkgVersion}\n\n${analytics.report(verbose)}` }] };
        }

        case 'find_unused': {
          const unusedArgs = validateFindUnusedArgs(args);
          const cachedUnused = sessionCache?.get('find_unused', unusedArgs);
          if (cachedUnused) {
            recordWithTrace({ tool: 'find_unused', path: unusedArgs.module ?? 'all', tokensReturned: cachedUnused.tokenEstimate, tokensWouldBe: cachedUnused.tokensWouldBe ?? cachedUnused.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: unusedArgs });
            return cachedUnused.result;
          }
          const unusedResult = await handleFindUnused(unusedArgs, astIndex);
          const unusedText = unusedResult.content[0]?.text ?? '';
          const unusedTokens = estimateTokens(unusedText);
          const unusedWouldBe = await estimateFindUsagesWorkflowTokens(unusedResult.meta.files);
          sessionCache?.set('find_unused', unusedArgs, unusedResult, { dependsOnAst: true }, unusedTokens, unusedWouldBe || unusedTokens);
          recordWithTrace({ tool: 'find_unused', path: unusedArgs.module ?? 'all', tokensReturned: unusedTokens, tokensWouldBe: unusedWouldBe || unusedTokens, timestamp: Date.now(), savingsCategory: 'compression', args: unusedArgs });
          return unusedResult;
        }

        case 'code_audit': {
          const auditArgs = validateCodeAuditArgs(args);
          const cachedAudit = sessionCache?.get('code_audit', auditArgs);
          if (cachedAudit) {
            recordWithTrace({ tool: 'code_audit', path: auditArgs.check, tokensReturned: cachedAudit.tokenEstimate, tokensWouldBe: cachedAudit.tokensWouldBe ?? cachedAudit.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: auditArgs });
            return cachedAudit.result;
          }
          const auditResult = await handleCodeAudit(auditArgs, projectRoot, astIndex);
          const auditText = auditResult.content[0]?.text ?? '';
          const auditTokens = estimateTokens(auditText);
          const auditWouldBe = await estimateFindUsagesWorkflowTokens(auditResult.meta.files);
          sessionCache?.set('code_audit', auditArgs, auditResult, { dependsOnAst: true }, auditTokens, auditWouldBe || auditTokens);
          recordWithTrace({ tool: 'code_audit', path: auditArgs.check, tokensReturned: auditTokens, tokensWouldBe: auditWouldBe || auditTokens, timestamp: Date.now(), savingsCategory: 'compression', args: auditArgs });
          return auditResult;
        }

        case 'module_info': {
          const moduleArgs = validateModuleInfoArgs(args);
          const cachedModule = sessionCache?.get('module_info', moduleArgs);
          if (cachedModule) {
            recordWithTrace({ tool: 'module_info', path: moduleArgs.module, tokensReturned: cachedModule.tokenEstimate, tokensWouldBe: cachedModule.tokensWouldBe ?? cachedModule.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: moduleArgs });
            return cachedModule.result;
          }
          const moduleResult = await handleModuleInfo(moduleArgs, projectRoot, astIndex);
          const moduleText = moduleResult.content[0]?.text ?? '';
          const moduleTokens = estimateTokens(moduleText);
          const moduleWouldBe = await estimateFindUsagesWorkflowTokens(moduleResult.meta.files);
          sessionCache?.set('module_info', moduleArgs, moduleResult, { dependsOnAst: true }, moduleTokens, moduleWouldBe || moduleTokens);
          recordWithTrace({ tool: 'module_info', path: moduleArgs.module, tokensReturned: moduleTokens, tokensWouldBe: moduleWouldBe || moduleTokens, timestamp: Date.now(), savingsCategory: 'compression', args: moduleArgs });
          return moduleResult;
        }

        case 'smart_diff': {
          const sdArgs = validateSmartDiffArgs(args);
          const sdResult = await handleSmartDiff(sdArgs, projectRoot, astIndex);
          const sdText = sdResult.content[0]?.text ?? '';
          const sdTokens = estimateTokens(sdText);
          recordWithTrace({ tool: 'smart_diff', path: sdArgs.path ?? sdArgs.scope ?? 'unstaged', tokensReturned: sdTokens, tokensWouldBe: sdResult.rawTokens || sdTokens, timestamp: Date.now(), savingsCategory: 'compression', args: sdArgs });
          return { content: sdResult.content };
        }

        case 'explore_area': {
          const eaArgs = validateExploreAreaArgs(args);
          const cachedEa = sessionCache?.get('explore_area', eaArgs);
          if (cachedEa) {
            recordWithTrace({ tool: 'explore_area', path: eaArgs.path, tokensReturned: cachedEa.tokenEstimate, tokensWouldBe: cachedEa.tokensWouldBe ?? cachedEa.tokenEstimate, timestamp: Date.now(), sessionCacheHit: true, savingsCategory: 'cache', args: eaArgs });
            return cachedEa.result;
          }
          const eaResult = await handleExploreArea(eaArgs, projectRoot, astIndex);
          const eaText = eaResult.content[0]?.text ?? '';
          const eaTokens = estimateTokens(eaText);
          const eaWouldBe = await estimateExploreAreaWorkflowTokens(eaResult.meta);
          sessionCache?.set('explore_area', eaArgs, eaResult, {
            files: [resolve(projectRoot, eaArgs.path) + '/'],
            dependsOnAst: true,
            dependsOnGit: true,
          }, eaTokens, eaWouldBe || eaTokens);
          recordWithTrace({
            tool: 'explore_area',
            path: eaArgs.path,
            tokensReturned: eaTokens,
            tokensWouldBe: eaWouldBe || eaTokens,
            timestamp: Date.now(),
            savingsCategory: 'compression',
            args: eaArgs,
          });
          return eaResult;
        }

        case 'smart_log': {
          const slArgs = validateSmartLogArgs(args);
          const slResult = await handleSmartLog(slArgs, projectRoot);
          const slText = slResult.content[0]?.text ?? '';
          const slTokens = estimateTokens(slText);
          recordWithTrace({ tool: 'smart_log', path: slArgs.path ?? 'all', tokensReturned: slTokens, tokensWouldBe: slResult.rawTokens || slTokens, timestamp: Date.now(), savingsCategory: 'compression', args: slArgs });
          return { content: slResult.content };
        }

        case 'test_summary': {
          const tsArgs = validateTestSummaryArgs(args);
          const tsResult = await handleTestSummary(tsArgs, projectRoot);
          const tsText = tsResult.content[0]?.text ?? '';
          const tsTokens = estimateTokens(tsText);
          recordWithTrace({ tool: 'test_summary', path: tsArgs.command, tokensReturned: tsTokens, tokensWouldBe: tsResult.rawTokens || tsTokens, timestamp: Date.now(), savingsCategory: 'compression', args: tsArgs });
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
