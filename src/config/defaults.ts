import type { TokenPilotConfig } from '../types.js';

export const DEFAULT_CONFIG: TokenPilotConfig = {
  astIndex: {
    binaryPath: null,
    buildOnStart: true,
    timeout: 5000,
  },
  cache: {
    maxSizeMB: 100,
    ttlMinutes: 30,
    watchFiles: true,
  },
  smartRead: {
    smallFileThreshold: 80,
    showDependencyHints: true,
    advisoryReminders: true,
  },
  git: {
    watchHead: true,
    selectiveInvalidation: true,
  },
  hooks: {
    enabled: true,
    interceptRead: true,
    autoInstall: true,
  },
  context: {
    estimateTokens: true,
    warnOnStale: true,
    autoForgetMinutes: 60,
  },
  display: {
    showImports: true,
    showDocs: true,
    showReferences: false,
    maxDepth: 2,
    showTokenSavings: true,
  },
  contextMode: {
    enabled: 'auto' as const,
    adviseDelegation: true,
    largeNonCodeThreshold: 200,
  },
  ignore: [
    'node_modules/**',
    'dist/**',
    '.git/**',
    '*.min.js',
    '*.map',
  ],
};
