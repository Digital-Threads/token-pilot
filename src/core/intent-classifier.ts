/**
 * Intent classifier — maps tool + args to a task intent category.
 * Used for per-intent analytics: which workflows save most tokens?
 */

export type Intent =
  | 'edit'      // preparing or verifying edits
  | 'debug'     // investigating failures or test issues
  | 'explore'   // understanding project structure
  | 'review'    // reviewing changes (git diff, log)
  | 'analyze'   // code quality, unused code, module deps
  | 'search'    // finding usages, related files
  | 'read';     // general code reading

const TOOL_INTENT_MAP: Record<string, Intent> = {
  // Edit workflow
  read_for_edit: 'edit',

  // Review workflow
  smart_diff: 'review',
  smart_log: 'review',
  read_diff: 'review',

  // Explore workflow
  project_overview: 'explore',
  explore_area: 'explore',
  outline: 'explore',

  // Search workflow
  find_usages: 'search',
  related_files: 'search',

  // Analyze workflow
  code_audit: 'analyze',
  find_unused: 'analyze',
  module_info: 'analyze',

  // Debug workflow
  test_summary: 'debug',

  // Read workflow (default for reading tools)
  smart_read: 'read',
  read_symbol: 'read',
  read_range: 'read',
  smart_read_many: 'read',

  // Analytics (meta — classify as explore)
  session_analytics: 'explore',
};

/**
 * Classify the intent of a tool call based on tool name and optional args.
 * Returns a stable intent category for analytics grouping.
 */
export function classifyIntent(tool: string, _args?: Record<string, unknown>): Intent {
  return TOOL_INTENT_MAP[tool] ?? 'read';
}

/** Get all known intents for iteration in reports. */
export const ALL_INTENTS: readonly Intent[] = [
  'edit', 'debug', 'explore', 'review', 'analyze', 'search', 'read',
] as const;
