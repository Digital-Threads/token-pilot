/**
 * Policy engine — configurable team policies for consistent token savings.
 * Phase 1: advisory-only warnings, no blocking.
 * Track 10: Team Policy Mode
 */

export interface PolicyConfig {
  /** Advisory hints when an expensive tool is used where a cheaper alternative exists */
  preferCheapReads: boolean;
  /** Track if read_for_edit was called before edit (advisory) */
  requireReadForEditBeforeEdit: boolean;
  /** Always cache project overview in session cache */
  cacheProjectOverview: boolean;
  /** Warn after N full-file reads in a session */
  maxFullFileReads: number;
  /** Warn when a single response exceeds this token threshold */
  warnOnLargeReads: boolean;
  /** Token threshold for large read warning */
  largeReadThreshold: number;
}

export const DEFAULT_POLICIES: PolicyConfig = {
  preferCheapReads: true,
  requireReadForEditBeforeEdit: true,
  cacheProjectOverview: true,
  maxFullFileReads: 10,
  warnOnLargeReads: true,
  largeReadThreshold: 2000,
};

/** Full-file read tools that count toward maxFullFileReads */
const FULL_READ_TOOLS = new Set([
  'smart_read',
  'smart_read_many',
]);

/** Tools that indicate a cheaper alternative may exist */
const EXPENSIVE_TOOLS: Record<string, string> = {
  smart_read: 'Consider read_symbol() or read_range() for targeted reads',
  smart_read_many: 'Consider reading files individually with read_symbol()',
};

export interface PolicyCheckContext {
  fullFileReadsCount: number;
  tokensReturned: number;
  readForEditCalled?: Set<string>;
  editTargetPath?: string;
}

export interface PolicyAdvisory {
  level: 'info' | 'warn';
  message: string;
}

/**
 * Check policy rules and return advisory messages.
 * Returns null if no policy violation detected.
 */
export function checkPolicy(
  policy: PolicyConfig,
  tool: string,
  context: PolicyCheckContext,
): PolicyAdvisory | null {
  // 1. Max full-file reads exceeded
  if (
    policy.maxFullFileReads > 0 &&
    FULL_READ_TOOLS.has(tool) &&
    context.fullFileReadsCount >= policy.maxFullFileReads
  ) {
    return {
      level: 'warn',
      message: `POLICY: ${context.fullFileReadsCount} full-file reads this session (limit: ${policy.maxFullFileReads}). Consider read_symbol() or read_range() for targeted access.`,
    };
  }

  // 2. Large read warning
  if (
    policy.warnOnLargeReads &&
    context.tokensReturned > policy.largeReadThreshold
  ) {
    return {
      level: 'info',
      message: `POLICY: Large response (~${context.tokensReturned} tokens). Future reads on this file: use read_symbol() or read_range() for targeted access.`,
    };
  }

  // 3. Prefer cheap reads advisory
  if (policy.preferCheapReads && EXPENSIVE_TOOLS[tool]) {
    // Only advise when token count is high enough to matter
    if (context.tokensReturned > 500) {
      return {
        level: 'info',
        message: `POLICY: ${EXPENSIVE_TOOLS[tool]}`,
      };
    }
  }

  // 4. Require read_for_edit before edit
  if (
    policy.requireReadForEditBeforeEdit &&
    tool === 'edit' &&
    context.editTargetPath &&
    context.readForEditCalled &&
    !context.readForEditCalled.has(context.editTargetPath)
  ) {
    return {
      level: 'info',
      message: `POLICY: Consider using read_for_edit("${context.editTargetPath}") before editing to get precise edit context.`,
    };
  }

  return null;
}

/**
 * Count how many full-file reads a tool represents.
 * Returns 1 for full-read tools, 0 for targeted tools.
 */
export function isFullReadTool(tool: string): boolean {
  return FULL_READ_TOOLS.has(tool);
}
