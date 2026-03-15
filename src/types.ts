/**
 * Core domain types for Token Pilot.
 */

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'property' | 'variable'
  | 'type' | 'interface' | 'enum' | 'constant' | 'namespace';

export type Visibility = 'public' | 'private' | 'protected' | 'default';

export interface FileStructure {
  path: string;
  language: string;
  meta: {
    lines: number;
    bytes: number;
    lastModified: number;
    contentHash: string;
  };
  imports: ImportDeclaration[];
  exports: ExportDeclaration[];
  symbols: SymbolInfo[];
}

export interface SymbolInfo {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string;
  location: {
    startLine: number;
    endLine: number;
    lineCount: number;
  };
  visibility: Visibility;
  async: boolean;
  static: boolean;
  decorators: string[];
  children: SymbolInfo[];
  doc: string | null;
  references: string[];
}

export interface ImportDeclaration {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface ExportDeclaration {
  name: string;
  kind: SymbolKind;
  isDefault: boolean;
  line: number;
}

export interface ResolvedSymbol {
  symbol: SymbolInfo;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ContextEntry {
  path: string;
  loaded: LoadedRegion[];
  contentHash: string;
  tokenEstimate: number;
  loadedAt: number;
}

export interface LoadedRegion {
  type: 'structure' | 'symbol' | 'range' | 'full';
  symbolName?: string;
  startLine: number;
  endLine: number;
  tokens: number;
}

export interface CacheEntry {
  structure: FileStructure;
  content: string;
  lines: string[];
  mtime: number;
  hash: string;
  lastAccess: number;
}

export interface TokenPilotConfig {
  astIndex: {
    binaryPath: string | null;
    buildOnStart: boolean;
    timeout: number;
  };
  cache: {
    maxSizeMB: number;
    watchFiles: boolean;
  };
  smartRead: {
    smallFileThreshold: number;
    showDependencyHints: boolean;
    advisoryReminders: boolean;
  };
  git: {
    watchHead: boolean;
    selectiveInvalidation: boolean;
  };
  hooks: {
    enabled: boolean;
    interceptRead: boolean;
    autoInstall: boolean;
  };
  context: {
    estimateTokens: boolean;
    warnOnStale: boolean;
  };
  display: {
    showImports: boolean;
    showDocs: boolean;
    showReferences: boolean;
    maxDepth: number;
    showTokenSavings: boolean;
  };
  contextMode: {
    enabled: boolean | 'auto';
    adviseDelegation: boolean;
    largeNonCodeThreshold: number;
  };
  updates: {
    checkOnStartup: boolean;
    autoUpdate: boolean;
  };
  sessionCache: {
    enabled: boolean;
    maxEntries: number;
  };
  ignore: string[];
}
