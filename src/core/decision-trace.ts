/**
 * Decision trace — captures pre/post-execution metadata for analytics.
 * Provides instrumentation data for budget planner advisory.
 */

import type { ContextRegistry } from './context-registry.js';
import type { FileCache } from './file-cache.js';
import { suggestCheaperAlternative } from './budget-planner.js';

export interface DecisionTrace {
  fileSize?: number;
  fileTotalLines?: number;
  alreadyInContext: boolean;
  estimatedCost: number;
  actualCost: number;
  cheaperAlternative?: string;
  cheaperEstimate?: number;
}

export interface BuildTraceOptions {
  absPath?: string;
  tool: string;
  args: Record<string, unknown>;
  contextRegistry: ContextRegistry;
  fileCache: FileCache;
  tokensReturned: number;
  tokensWouldBe: number;
  recentlyEdited?: boolean;
}

/**
 * Build a decision trace for a tool call.
 * Gathers file metadata, context state, and budget planner advice.
 */
export function buildDecisionTrace(opts: BuildTraceOptions): DecisionTrace {
  const { absPath, tool, args, contextRegistry, fileCache, tokensReturned, tokensWouldBe } = opts;

  let fileSize: number | undefined;
  let fileTotalLines: number | undefined;
  let alreadyInContext = false;

  if (absPath) {
    // Get file info from cache if available
    const cached = fileCache.get(absPath);
    if (cached) {
      fileSize = cached.structure?.meta?.bytes;
      fileTotalLines = cached.lines?.length ?? cached.structure?.meta?.lines;
    }
    alreadyInContext = contextRegistry.hasAnyLoaded(absPath);
  }

  const trace: DecisionTrace = {
    fileSize,
    fileTotalLines,
    alreadyInContext,
    estimatedCost: tokensWouldBe,
    actualCost: tokensReturned,
  };

  // Budget planner advisory
  const symbolKnown = !!(args.symbol || args.name);
  const suggestion = suggestCheaperAlternative(tool, args, {
    fileLines: fileTotalLines,
    alreadyInContext,
    symbolKnown,
    recentlyEdited: opts.recentlyEdited ?? false,
  });

  if (suggestion) {
    trace.cheaperAlternative = suggestion.tool;
    trace.cheaperEstimate = suggestion.estimatedTokens;
  }

  return trace;
}
