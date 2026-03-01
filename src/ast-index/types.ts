/**
 * Types for ast-index CLI JSON output.
 * These map to the ACTUAL JSON responses from ast-index v3.24.0 commands.
 */

/** ast-index outline — parsed from text output (JSON not supported) */
export interface AstIndexOutlineEntry {
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature?: string;
  visibility?: string;
  is_async?: boolean;
  is_static?: boolean;
  decorators?: string[];
  doc?: string;
  children?: AstIndexOutlineEntry[];
}

/** ast-index symbol --format json → Array<AstIndexSymbolRaw> */
export interface AstIndexSymbolRaw {
  name: string;
  kind: string;
  line: number;
  signature?: string;
  path: string;
}

/** Normalized symbol detail (internal) */
export interface AstIndexSymbolDetail {
  name: string;
  kind: string;
  file: string;
  start_line: number;
  signature?: string;
}

/** ast-index search --format json → { content_matches: [...] } */
export interface AstIndexSearchResponse {
  content_matches: AstIndexSearchMatch[];
}

export interface AstIndexSearchMatch {
  content: string;
  line: number;
  path: string;
}

/** Normalized search result (internal) */
export interface AstIndexSearchResult {
  file: string;
  line: number;
  text: string;
}

/** ast-index usages --format json → Array<AstIndexUsageRaw> */
export interface AstIndexUsageRaw {
  name: string;
  line: number;
  context: string;
  path: string;
}

/** Normalized usage result (internal) */
export interface AstIndexUsageResult {
  file: string;
  line: number;
  text: string;
  kind: string;
}

export interface AstIndexImplementation {
  name: string;
  file: string;
  line: number;
  kind: string;
  methods?: string[];
}

export interface AstIndexHierarchyNode {
  name: string;
  kind: string;
  file?: string;
  line?: number;
  children?: AstIndexHierarchyNode[];
  parents?: AstIndexHierarchyNode[];
}

/** ast-index refs --format json */
export interface AstIndexRefsResponse {
  definitions: AstIndexRefEntry[];
  imports: AstIndexRefEntry[];
  usages: AstIndexRefEntry[];
}

export interface AstIndexRefEntry {
  name: string;
  kind?: string;
  line: number;
  path: string;
  signature?: string;
  context?: string;
}

/** ast-index map --format json */
export interface AstIndexMapResponse {
  project_type: string;
  file_count: number;
  module_count: number;
  showing: number;
  total_dirs: number;
  groups: AstIndexMapGroup[];
}

export interface AstIndexMapGroup {
  path: string;
  file_count: number;
  kinds?: Record<string, number>;
}

/** ast-index conventions --format json */
export interface AstIndexConventionsResponse {
  architecture: string[];
  frameworks: Record<string, Array<{ name: string; count: number }>>;
  naming_patterns: Array<{ suffix: string; count: number }>;
}

/** ast-index callers --format json */
export interface AstIndexCallerEntry {
  name: string;
  line: number;
  path: string;
  context?: string;
}

/** ast-index call-tree --format json */
export interface AstIndexCallTreeNode {
  name: string;
  file?: string;
  line?: number;
  callers?: AstIndexCallTreeNode[];
}

/** ast-index changed --format json */
export interface AstIndexChangedEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  change_type: string; // added, modified, removed
}

/** ast-index unused-symbols --format json */
export interface AstIndexUnusedSymbol {
  name: string;
  kind: string;
  line: number;
  path: string;
  signature?: string;
}

/** ast-index imports (text format) */
export interface AstIndexImportEntry {
  specifiers: string[];
  source: string;
  isDefault?: boolean;
  isNamespace?: boolean;
}
