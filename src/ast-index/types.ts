/**
 * Types for ast-index CLI JSON output.
 * These map to the JSON responses from ast-index commands.
 */

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

export interface AstIndexSymbolDetail {
  name: string;
  qualified_name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  signature?: string;
  references?: string[];
}

export interface AstIndexSearchResult {
  file: string;
  line: number;
  column?: number;
  text: string;
  symbol?: string;
  symbol_kind?: string;
}

export interface AstIndexUsageResult {
  file: string;
  line: number;
  text: string;
  kind: string; // "definition" | "call" | "reference" | "import"
  enclosing_symbol?: string;
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
}
