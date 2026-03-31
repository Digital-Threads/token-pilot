import type { AstIndexClient } from '../ast-index/client.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import type { TokenPilotConfig } from '../types.js';
import { handleSmartRead } from './smart-read.js';
import { estimateTokens, formatSavings } from '../core/token-estimator.js';
import { readFile } from 'node:fs/promises';
import { resolveSafePath } from '../core/validation.js';

export interface SmartReadManyArgs {
  paths: string[];
}

const MAX_BATCH_FILES = 20;
const MAX_BATCH_TOKENS = 1400;
const MAX_FILE_TOKENS = 220;
const MAX_FILE_LINES = 24;
const BATCH_CONCURRENCY = 4;

interface BatchEntry {
  path: string;
  text: string;
  fullTokens: number;
}

export async function handleSmartReadMany(
  args: SmartReadManyArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  config: TokenPilotConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.paths || args.paths.length === 0) {
    return {
      content: [{ type: 'text', text: 'No paths provided.' }],

    };
  }

  if (args.paths.length > MAX_BATCH_FILES) {
    return {
      content: [{ type: 'text', text: `Too many files (${args.paths.length}). Maximum is ${MAX_BATCH_FILES} per batch.` }],
    };
  }

  const uniquePaths = Array.from(new Set(args.paths));
  const entries: BatchEntry[] = [];

  for (let i = 0; i < uniquePaths.length; i += BATCH_CONCURRENCY) {
    const batch = uniquePaths.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (path): Promise<BatchEntry> => {
        // Per-file dedup: if file is in context and unchanged, return compact reminder
        const absPath = resolveSafePath(projectRoot, path);
        const cachedFile = fileCache.get(absPath);
        if (cachedFile && contextRegistry.hasAnyLoaded(absPath) && !contextRegistry.isStale(absPath, cachedFile.hash)) {
          const reminder = contextRegistry.compactReminder(absPath, cachedFile.structure?.symbols ?? []);
          const reminderText = reminder || `FILE: ${path} (already in context, unchanged)`;
          const fullTokens = await estimateFullFileTokens(projectRoot, path);
          return { path, text: reminderText + `\nFor full re-read: smart_read("${path}")`, fullTokens };
        }

        const result = await handleSmartRead(
          { path },
          projectRoot,
          astIndex,
          fileCache,
          contextRegistry,
          config,
        );
        const text = result.content[0]?.text ?? '';
        const fullTokens = await estimateFullFileTokens(projectRoot, path);
        return { path, text, fullTokens };
      }),
    );

    for (let index = 0; index < settled.length; index++) {
      const outcome = settled[index];
      const path = batch[index];

      if (outcome.status === 'fulfilled') {
        entries.push(outcome.value);
      } else {
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        entries.push({ path, text: `FILE: ${path}\nERROR: ${msg}`, fullTokens: 0 });
      }
    }
  }

  let remainingBudget = MAX_BATCH_TOKENS;
  const renderedEntries: string[] = [];

  for (const entry of entries) {
    const compacted = compactBatchEntry(entry, remainingBudget);
    renderedEntries.push(compacted);
    remainingBudget = Math.max(0, remainingBudget - estimateTokens(compacted));
  }

  const body = renderedEntries.join('\n\n---\n\n');
  const actualTokens = estimateTokens(body);
  const fullTokens = entries.reduce((sum, entry) => sum + entry.fullTokens, 0);
  const duplicatesRemoved = args.paths.length - uniquePaths.length;

  const footer: string[] = [''];
  footer.push(`BATCH: ${uniquePaths.length} unique files loaded${duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicates skipped)` : ''}`);
  footer.push(`OUTPUT: ~${actualTokens} tokens`);
  if (fullTokens > 0) {
    footer.push(formatSavings(actualTokens, fullTokens));
  }
  footer.push('HINT: Re-run smart_read(path) on any compacted file for full detail.');

  return { content: [{ type: 'text', text: body + '\n' + footer.join('\n') }] };
}

function compactBatchEntry(entry: BatchEntry, remainingBudget: number): string {
  const rawTokens = estimateTokens(entry.text);
  if (remainingBudget <= 60) {
    return `FILE: ${entry.path}\n(compacted in batch mode — use smart_read("${entry.path}") for full detail)`;
  }

  if (rawTokens <= Math.min(MAX_FILE_TOKENS, remainingBudget)) {
    return entry.text;
  }

  const lines = entry.text.split('\n');
  const head = lines.slice(0, MAX_FILE_LINES).join('\n');
  const suffix = `\n\n... compacted for batch mode. Use smart_read("${entry.path}") for full detail.`;
  return head + suffix;
}

async function estimateFullFileTokens(projectRoot: string, relativePath: string): Promise<number> {
  try {
    const absPath = resolveSafePath(projectRoot, relativePath);
    const content = await readFile(absPath, 'utf-8');
    return estimateTokens(content);
  } catch {
    return 0;
  }
}
