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
import { parseTypeScriptRegex } from '../ast-index/regex-parser.js';
import { buildFileStructure } from '../ast-index/enricher.js';
import { formatDuration } from '../core/format-duration.js';

const TS_JS_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
import { assessConfidence, formatConfidence } from '../core/confidence.js';

export interface SmartReadArgs {
  path: string;
  show_imports?: boolean;
  show_docs?: boolean;
  show_references?: boolean;
  depth?: number;
  scope?: 'full' | 'nav' | 'exports';
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
    let structure = await astIndex.outline(absPath);

    if (!structure) {
      // ast-index doesn't support this file type
      // Try non-code structural summary (JSON, YAML, Markdown, TOML)
      if (isNonCodeStructured(absPath)) {
        const nonCodeResult = await handleNonCodeRead(args.path, projectRoot, contextRegistry);
        if (nonCodeResult) return nonCodeResult;
      }

      // Regex fallback for TS/JS when binary is unavailable
      const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
      if (TS_JS_EXTENSIONS.has(ext)) {
        const regexEntries = parseTypeScriptRegex(content);
        if (regexEntries.length > 0) {
          structure = await buildFileStructure(absPath, regexEntries);
        }
      }
    }

    if (!structure) {
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

  // 5b. Auto-delta: file changed since last load, recently loaded
  if (
    config.smartRead.autoDelta?.enabled &&
    previouslyLoaded &&
    contextRegistry.isStale(absPath, cached.hash)
  ) {
    const loadedAt = contextRegistry.getLoadedAt(absPath);
    if (loadedAt !== undefined && (Date.now() - loadedAt) < (config.smartRead.autoDelta.maxAgeSec ?? 120) * 1000) {
      const prevNames = contextRegistry.getSymbolNames(absPath) ?? [];
      const currentNames = cached.structure.symbols.map((s: { name: string }) => s.name);

      const added = currentNames.filter((n: string) => !prevNames.includes(n));
      const removed = prevNames.filter((n: string) => !currentNames.includes(n));
      const unchanged = currentNames.filter((n: string) => prevNames.includes(n));

      const elapsed = formatDuration(Date.now() - loadedAt);
      const deltaLines: string[] = [
        `FILE: ${args.path} (DELTA — changed since last read ${elapsed} ago)`,
        '',
      ];

      if (added.length > 0) {
        deltaLines.push('ADDED:');
        for (const name of added) {
          const sym = cached.structure.symbols.find((s: { name: string }) => s.name === name);
          if (sym) deltaLines.push(`  ${sym.kind} ${sym.signature} [L${sym.location.startLine}-${sym.location.endLine}]`);
        }
        deltaLines.push('');
      }

      if (removed.length > 0) {
        deltaLines.push(`REMOVED: ${removed.join(', ')}`);
        deltaLines.push('');
      }

      if (unchanged.length > 0) {
        deltaLines.push(`UNCHANGED (${unchanged.length} symbols):`);
        for (const name of (unchanged as string[]).slice(0, 15)) {
          const sym = cached.structure.symbols.find((s: { name: string }) => s.name === name);
          if (sym) deltaLines.push(`  ${sym.name} [L${sym.location.startLine}-${sym.location.endLine}]`);
        }
        if (unchanged.length > 15) deltaLines.push(`  ... and ${unchanged.length - 15} more`);
        deltaLines.push('');
      }

      deltaLines.push(`HINT: For full re-read: smart_read("${args.path}", scope="full")`);

      const deltaText = deltaLines.join('\n');
      const deltaTokens = estimateTokens(deltaText);
      contextRegistry.trackLoad(absPath, { type: 'structure', startLine: 1, endLine: cached.structure.meta.lines, tokens: deltaTokens });
      contextRegistry.setContentHash(absPath, cached.hash);
      contextRegistry.trackStructureSymbols(absPath, currentNames);

      return { content: [{ type: 'text', text: deltaText }] };
    }
  }

  // 6. Format output
  const output = formatOutline(cached.structure, {
    showImports: args.show_imports ?? config.display.showImports,
    showDocs: args.show_docs ?? config.display.showDocs,
    showDependencyHints: config.smartRead.showDependencyHints,
    maxDepth: args.depth ?? config.display.maxDepth,
    scope: args.scope ?? 'full',
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
    if (cached.structure.symbols.length > 0) {
      contextRegistry.trackStructureSymbols(absPath, cached.structure.symbols.map((s: { name: string }) => s.name));
    }

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
  contextRegistry.trackStructureSymbols(absPath, cached.structure.symbols.map((s: { name: string }) => s.name));

  // 9. Confidence metadata
  const confidenceMeta = assessConfidence({
    symbolResolved: (cached.structure.symbols?.length ?? 0) > 0,
    fullFile: false,
    truncated: false,
    astAvailable: true,
    crossFileDeps: cached.structure.imports?.length ?? 0,
  });

  return { content: [{ type: 'text', text: output + savings + formatConfidence(confidenceMeta) }] };
}
