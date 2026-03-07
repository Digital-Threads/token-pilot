import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AstIndexClient } from '../ast-index/client.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import type { TokenPilotConfig } from '../types.js';
import { formatOutline } from '../formatters/structure.js';
import { estimateTokens, formatSavings } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';
import { isNonCodeStructured, handleNonCodeRead } from './non-code.js';

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

  // 0. Guard: directory passed instead of file
  const fileStat0 = await stat(absPath).catch(() => null);
  if (fileStat0?.isDirectory()) {
    return {
      content: [{
        type: 'text',
        text: `"${args.path}" is a directory. Use outline("${args.path}") for directory overview, or smart_read a specific file inside it.`,
      }],
    };
  }

  // 1. Read file content
  const content = await readFile(absPath, 'utf-8');
  const lines = content.split('\n');

  // 2. Small-file pass-through
  if (lines.length <= config.smartRead.smallFileThreshold) {
    const hash = createHash('sha256').update(content).digest('hex');
    const tokens = estimateTokens(content);
    contextRegistry.trackLoad(absPath, {
      type: 'full',
      startLine: 1,
      endLine: lines.length,
      tokens,
    });
    contextRegistry.setContentHash(absPath, hash);

    // Cache for read_diff baseline (so read_diff works after external edits)
    if (!fileCache.get(absPath)) {
      const fileStat = await stat(absPath);
      fileCache.set(absPath, {
        structure: {
          path: absPath, language: 'unknown',
          meta: { lines: lines.length, bytes: content.length, lastModified: fileStat.mtimeMs, contentHash: hash },
          imports: [], exports: [], symbols: [],
        },
        content, lines, mtime: fileStat.mtimeMs, hash, lastAccess: Date.now(),
      });
    }

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
      // ast-index doesn't support this file type
      // Try non-code structural summary (JSON, YAML, Markdown, TOML)
      if (isNonCodeStructured(absPath)) {
        const nonCodeResult = await handleNonCodeRead(args.path, projectRoot, contextRegistry);
        if (nonCodeResult) return nonCodeResult;
      }

      // Fallback: return truncated preview instead of full raw content
      const previewLines = 60;
      const truncated = lines.length > previewLines;
      const preview = lines.slice(0, previewLines).join('\n');
      const tokens = estimateTokens(preview);
      contextRegistry.trackLoad(absPath, { type: 'structure', startLine: 1, endLine: lines.length, tokens });

      return {
        content: [{
          type: 'text',
          text: `FILE: ${args.path} (${lines.length} lines — no AST support, preview)\n\n${preview}`
            + (truncated ? `\n\n... truncated (${lines.length - previewLines} more lines). Use read_range() for full content.` : ''),
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

  // 6b. Adaptive fallback: if outline is not significantly smaller than raw, return raw
  const structureTokens = estimateTokens(output);
  const fullTokens = estimateTokens(content);

  if (structureTokens >= fullTokens * 0.7) {
    contextRegistry.trackLoad(absPath, {
      type: 'full',
      startLine: 1,
      endLine: lines.length,
      tokens: fullTokens,
    });
    contextRegistry.setContentHash(absPath, cached.hash);

    return {
      content: [{
        type: 'text',
        text: `FILE: ${args.path} (${lines.length} lines — returned in full, outline not smaller)\n\n${content}`,
      }],
    };
  }

  // 7. Add token savings
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
