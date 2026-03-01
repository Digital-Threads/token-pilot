import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AstIndexClient } from '../ast-index/client.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import type { TokenPilotConfig } from '../types.js';
import { formatOutline } from '../formatters/structure.js';
import { estimateTokens, formatSavings } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';

export interface SmartReadArgs {
  path: string;
  show_imports?: boolean;
  show_docs?: boolean;
  show_references?: boolean;
  depth?: number;
}

export async function handleSmartRead(
  args: SmartReadArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  config: TokenPilotConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);

  // 1. Read file content
  const content = await readFile(absPath, 'utf-8');
  const lines = content.split('\n');

  // 2. Small-file pass-through
  if (lines.length <= config.smartRead.smallFileThreshold) {
    const tokens = estimateTokens(content);
    contextRegistry.trackLoad(absPath, {
      type: 'full',
      startLine: 1,
      endLine: lines.length,
      tokens,
    });
    contextRegistry.setContentHash(absPath, createHash('sha256').update(content).digest('hex'));

    return {
      content: [{
        type: 'text',
        text: `FILE: ${args.path} (${lines.length} lines — returned in full, below threshold)\n\n${content}`,
      }],
    };
  }

  // 3. Check cache
  let cached = fileCache.get(absPath);
  const isStale = cached ? await fileCache.isStale(absPath) : true;

  if (!cached || isStale) {
    // 4. Get structure from ast-index
    const structure = await astIndex.outline(absPath);

    if (!structure) {
      // ast-index doesn't support this — return raw
      return {
        content: [{
          type: 'text',
          text: `FILE: ${args.path} (${lines.length} lines — language not supported, raw content)\n\n${content}`,
        }],
      };
    }

    const fileStat = await stat(absPath);
    const hash = createHash('sha256').update(content).digest('hex');

    cached = {
      structure,
      content,
      lines,
      mtime: fileStat.mtimeMs,
      hash,
      lastAccess: Date.now(),
    };
    fileCache.set(absPath, cached);
  }

  // 5. Advisory context check
  const previouslyLoaded = contextRegistry.getLoaded(absPath);
  if (previouslyLoaded && !contextRegistry.isStale(absPath, cached.hash)) {
    if (config.smartRead.advisoryReminders) {
      const reminder = contextRegistry.compactReminder(absPath, cached.structure.symbols);
      return { content: [{ type: 'text', text: reminder }] };
    }
  }

  // 6. Format output
  const output = formatOutline(cached.structure, {
    showImports: args.show_imports ?? config.display.showImports,
    showDocs: args.show_docs ?? config.display.showDocs,
    showDependencyHints: config.smartRead.showDependencyHints,
    maxDepth: args.depth ?? config.display.maxDepth,
  });

  // 7. Add token savings
  const structureTokens = estimateTokens(output);
  const fullTokens = estimateTokens(content);
  const savings = config.display.showTokenSavings
    ? '\n' + formatSavings(structureTokens, fullTokens)
    : '';

  // 8. Track
  contextRegistry.trackLoad(absPath, {
    type: 'structure',
    startLine: 1,
    endLine: cached.structure.meta.lines,
    tokens: structureTokens,
  });
  contextRegistry.setContentHash(absPath, cached.hash);

  return { content: [{ type: 'text', text: output + savings }] };
}
