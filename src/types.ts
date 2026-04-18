/**
 * Core domain types for Token Pilot.
 */

/**
 * Hook enforcement mode.
 * - 'off': PreToolUse hook is inert (no advisory, no deny).
 * - 'advisory': hook emits a short tip but does not block Read.
 * - 'deny-enhanced': hook denies oversized code Reads and returns a structural
 *   summary inside permissionDecisionReason. Default from v0.20; preserves
 *   v0.19 deny-behaviour while upgrading the message quality.
 */
export type HookMode = "off" | "advisory" | "deny-enhanced";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "property"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "constant"
  | "namespace";

export type Visibility = "public" | "private" | "protected" | "default";

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
  symbolNames?: string[];
}

export interface LoadedRegion {
  type: "structure" | "symbol" | "range" | "full";
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
    autoDelta: {
      enabled: boolean;
      maxAgeSec: number;
    };
  };
  git: {
    watchHead: boolean;
    selectiveInvalidation: boolean;
  };
  hooks: {
    enabled: boolean;
    interceptRead: boolean;
    autoInstall: boolean;
    denyThreshold: number;
    mode: HookMode;
    /**
     * When true, hook auto-lowers denyThreshold as session burns through
     * adaptiveBudgetTokens. Opt-in — default false keeps v0.20 behaviour.
     */
    adaptiveThreshold: boolean;
    /**
     * Reference budget (in saved-token units from hook-events.jsonl) used
     * to compute burn fraction. Defaults to a rough 100k proxy.
     */
    adaptiveBudgetTokens: number;
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
    actionableHints: boolean;
  };
  contextMode: {
    enabled: boolean | "auto";
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
  policies: {
    preferCheapReads: boolean;
    requireReadForEditBeforeEdit: boolean;
    cacheProjectOverview: boolean;
    maxFullFileReads: number;
    warnOnLargeReads: boolean;
    largeReadThreshold: number;
    compactionCallThreshold: number;
    compactionTokenThreshold: number;
  };
  sessionStart: {
    enabled: boolean;
    showStats: boolean;
    maxReminderTokens: number;
  };
  agents: {
    /** Scope of last `install-agents` run, null until first install. */
    scope: "user" | "project" | null;
    /**
     * Emit a one-time stderr reminder at MCP startup if no tp-* agents
     * are installed. Can also be suppressed by env TOKEN_PILOT_NO_AGENT_REMINDER=1.
     */
    reminder: boolean;
  };
  ignore: string[];
}
