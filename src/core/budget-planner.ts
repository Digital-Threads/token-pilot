/**
 * Budget planner — advisory layer that suggests cheaper tool alternatives.
 * Phase 1: analytics-only, no active blocking.
 */

export interface CheaperAlternative {
  tool: string;
  estimatedTokens: number;
  reason: string;
}

export interface BudgetContext {
  fileLines?: number;
  alreadyInContext: boolean;
  symbolKnown: boolean;
  recentlyEdited: boolean;
}

/**
 * Given the tool that was used and the context, suggest a cheaper alternative.
 * Returns null if the chosen tool was already optimal.
 */
export function suggestCheaperAlternative(
  usedTool: string,
  args: Record<string, unknown>,
  context: BudgetContext,
): CheaperAlternative | null {
  const fileLines = context.fileLines ?? 0;

  switch (usedTool) {
    case 'smart_read': {
      // If file is already in context and was recently edited, read_diff is much cheaper
      if (context.alreadyInContext && context.recentlyEdited) {
        return {
          tool: 'read_diff',
          estimatedTokens: Math.max(20, Math.round(fileLines * 0.1)),
          reason: 'file already in context and recently edited — read_diff shows only changes',
        };
      }
      // If a specific symbol is known, read_symbol is cheaper
      if (context.symbolKnown && fileLines > 50) {
        return {
          tool: 'read_symbol',
          estimatedTokens: Math.round(fileLines * 0.15),
          reason: 'specific symbol known — read_symbol returns only the target',
        };
      }
      break;
    }

    case 'smart_read_many': {
      // If all files are already in context, this is wasteful
      if (context.alreadyInContext) {
        return {
          tool: 'read_diff',
          estimatedTokens: Math.max(20, Math.round(fileLines * 0.1)),
          reason: 'files already in context — use read_diff for changed files only',
        };
      }
      break;
    }

    case 'read_range': {
      // Large ranges (>60 lines) could use read_symbol if symbol is known
      const limit = typeof args.limit === 'number' ? args.limit : 0;
      if (limit > 60 && context.symbolKnown) {
        return {
          tool: 'read_symbol',
          estimatedTokens: Math.round(limit * 0.4),
          reason: 'large range with known symbol — read_symbol is more targeted',
        };
      }
      break;
    }

    case 'read_symbol': {
      // If file was recently edited and symbol already loaded, read_diff is better
      if (context.alreadyInContext && context.recentlyEdited) {
        return {
          tool: 'read_diff',
          estimatedTokens: Math.max(20, Math.round(fileLines * 0.1)),
          reason: 'symbol already loaded and file edited — read_diff shows changes only',
        };
      }
      break;
    }
  }

  return null;
}
