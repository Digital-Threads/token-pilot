import type { AstIndexClient } from '../ast-index/client.js';
import type { FileCache } from '../core/file-cache.js';
import { ContextRegistry } from '../core/context-registry.js';
import type { TokenPilotConfig } from '../types.js';
import { handleSmartRead } from './smart-read.js';
import { estimateTokens, formatSavings } from '../core/token-estimator.js';
import { readFile } from 'node:fs/promises';
import { resolveSafePath } from '../core/validation.js';

export interface SmartReadManyArgs {
  paths: string[];
  /** Token budget per file. */
  max_tokens?: number;
}

const MAX_BATCH_FILES = 20;
/** Per-file and whole-batch budgets when max_tokens is not given. */
const DEFAULT_FILE_TOKENS = 1500;
const DEFAULT_BATCH_TOKENS = 6000;
const BATCH_CONCURRENCY = 4;

interface BatchEntry {
  path: string;
  text: string;
  fullTokens: number;
  failed?: boolean;
  absPath?: string;
  /** What smart_read registered; copied to the real registry only if the file is shown whole. */
  scratch?: ContextRegistry;
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

        const scratch = new ContextRegistry();
        const result = await handleSmartRead(
          { path, max_tokens: args.max_tokens },
          projectRoot,
          astIndex,
          fileCache,
          scratch,
          config,
        );
        const text = result.content[0]?.text ?? '';
        const fullTokens = await estimateFullFileTokens(projectRoot, path);
        return { path, text, fullTokens, absPath, scratch };
      }),
    );

    for (let index = 0; index < settled.length; index++) {
      const outcome = settled[index];
      const path = batch[index];

      if (outcome.status === 'fulfilled') {
        entries.push(outcome.value);
      } else {
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        entries.push({ path, text: `FILE: ${path}\nERROR: ${msg}`, fullTokens: 0, failed: true });
      }
    }
  }

  const perFile = args.max_tokens ?? DEFAULT_FILE_TOKENS;
  let remainingBudget = args.max_tokens ? args.max_tokens * entries.length : DEFAULT_BATCH_TOKENS;
  const renderedEntries: string[] = [];

  for (const entry of entries) {
    const tokens = estimateTokens(entry.text);
    const allowed = Math.min(perFile, remainingBudget);
    let shown: string;
    if (entry.failed || tokens <= allowed) {
      shown = entry.text;
      // register only what the agent actually gets to see
      if (entry.scratch && entry.absPath) copyLoads(entry.scratch, contextRegistry, entry.absPath);
    } else {
      shown = compactBatchEntry(entry, allowed);
    }
    renderedEntries.push(shown);
    remainingBudget = Math.max(0, remainingBudget - estimateTokens(shown));
  }

  const body = renderedEntries.join('\n\n---\n\n');
  const actualTokens = estimateTokens(body);
  const fullTokens = entries.reduce((sum, entry) => sum + entry.fullTokens, 0);
  const duplicatesRemoved = args.paths.length - uniquePaths.length;
  const failed = entries.filter((e) => e.failed).length;

  const footer: string[] = [''];
  footer.push(
    `BATCH: ${entries.length - failed} unique files loaded`
    + (failed > 0 ? `, ${failed} failed` : '')
    + (duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicates skipped)` : ''),
  );
  footer.push(`OUTPUT: ~${actualTokens} tokens`);
  if (fullTokens > 0) {
    footer.push(formatSavings(actualTokens, fullTokens));
  }
  footer.push('HINT: Re-run smart_read(path) on any compacted file for full detail.');

  return { content: [{ type: 'text', text: body + '\n' + footer.join('\n') }] };
}

/** The first part of an entry that fits `budget`, labelled as cut — never "in full". */
function compactBatchEntry(entry: BatchEntry, budget: number): string {
  const hint = `\n\n... compacted for batch mode. Use smart_read("${entry.path}") for full detail.`;
  if (budget <= 60) {
    return `FILE: ${entry.path}\n(not shown — batch budget used up)${hint}`;
  }

  const lines = entry.text.split('\n');
  lines[0] = lines[0].replace(/returned in full[^)]*/, 'compacted for batch mode, first part only');
  const kept: string[] = [];
  let used = estimateTokens(hint);
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return kept.join('\n') + hint;
}

function copyLoads(from: ContextRegistry, to: ContextRegistry, absPath: string): void {
  const entry = from.toSnapshot().entries.find((e) => e.path === absPath);
  if (!entry) return;
  for (const region of entry.loaded) to.trackLoad(absPath, region);
  if (entry.contentHash) to.setContentHash(absPath, entry.contentHash);
  const symbols = from.getSymbolNames(absPath);
  if (symbols) to.trackStructureSymbols(absPath, symbols);
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
