import type { TokenPilotConfig } from "../types.js";

export const DEFAULT_CONFIG: TokenPilotConfig = {
  astIndex: {
    binaryPath: null,
    buildOnStart: true,
    timeout: 5000,
  },
  cache: {
    maxSizeMB: 100,
    watchFiles: true,
  },
  smartRead: {
    smallFileThreshold: 200,
    showDependencyHints: true,
    advisoryReminders: true,
    autoDelta: {
      enabled: true,
      maxAgeSec: 120,
    },
  },
  git: {
    watchHead: true,
    selectiveInvalidation: true,
  },
  hooks: {
    enabled: true,
    interceptRead: true,
    autoInstall: true,
    denyThreshold: 300,
    mode: "deny-enhanced",
  },
  context: {
    estimateTokens: true,
    warnOnStale: true,
  },
  display: {
    showImports: true,
    showDocs: true,
    showReferences: false,
    maxDepth: 2,
    showTokenSavings: true,
    actionableHints: true,
  },
  contextMode: {
    enabled: "auto" as const,
    adviseDelegation: true,
    largeNonCodeThreshold: 200,
  },
  updates: {
    checkOnStartup: true,
    autoUpdate: false,
  },
  sessionCache: {
    enabled: true,
    maxEntries: 200,
  },
  policies: {
    preferCheapReads: true,
    requireReadForEditBeforeEdit: true,
    cacheProjectOverview: true,
    maxFullFileReads: 10,
    warnOnLargeReads: true,
    largeReadThreshold: 2000,
    compactionCallThreshold: 15,
    compactionTokenThreshold: 8000,
  },
  ignore: ["node_modules/**", "dist/**", ".git/**", "*.min.js", "*.map"],
};
