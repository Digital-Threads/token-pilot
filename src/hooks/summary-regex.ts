/**
 * In-process regex-based structural summary parser.
 *
 * Fallback when the bundled ast-index binary is unavailable. Intentionally
 * coarse: extracts imports, exports, and major top-level declarations per
 * language using line-oriented regex. Never throws — worst case returns
 * empty signals.
 *
 * Used by the hook summary pipeline (Phase 1 subtask 1.6).
 */

import type { HookSummary, SignalKind, SignalLine } from "./summary-types.js";

// Re-exported for callers that imported these from summary-regex historically.
// Canonical home is summary-types.ts.
export type { HookSummary, SignalKind, SignalLine };

const MAX_TEXT_LEN = 140;

interface LanguagePattern {
  /** Regex that classifies a line as `import` when it matches. */
  import?: RegExp;
  /** Regex that classifies a line as `export`. Tried before `declaration`. */
  export?: RegExp;
  /** Regex that classifies a line as top-level `declaration`. */
  declaration?: RegExp;
}

const EXTENSIONS: Record<string, LanguagePattern> = {
  ts: tsJsPattern(),
  tsx: tsJsPattern(),
  js: tsJsPattern(),
  jsx: tsJsPattern(),
  mjs: tsJsPattern(),
  cjs: tsJsPattern(),
  py: pythonPattern(),
  go: goPattern(),
  rs: rustPattern(),
};

function tsJsPattern(): LanguagePattern {
  return {
    // Covers ES modules and CommonJS: `import ...`, `const x = require(...)`
    import: /^\s*(import\s|const\s+\w+\s*=\s*require\s*\()/,
    // export keyword, module.exports, exports.foo =
    export: /^\s*(export\s|module\.exports\s*=|exports\.\w+\s*=)/,
    // top-level declarations not prefixed with export — function/class/interface/type/enum
    declaration: /^\s*(async\s+)?(function|class|interface|type|enum)\s+\w+/,
  };
}

function pythonPattern(): LanguagePattern {
  return {
    import: /^\s*(import\s|from\s+\S+\s+import\s)/,
    declaration: /^\s*(async\s+)?(def\s+\w+|class\s+\w+)/,
  };
}

function goPattern(): LanguagePattern {
  return {
    import: /^\s*import\s/,
    declaration: /^\s*(func\s|type\s+\w+\s+(struct|interface|func))/,
  };
}

function rustPattern(): LanguagePattern {
  return {
    import: /^\s*use\s/,
    export: /^\s*pub\s+(fn|struct|trait|enum|type|mod|const|static)\s/,
    declaration: /^\s*(async\s+)?(fn|struct|trait|enum|type|mod)\s+\w+/,
  };
}

/**
 * Derive the lower-case extension for a file path.
 * Returns an empty string if the path has no dot.
 */
function extractExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filePath.length - 1) return "";
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  // Guard against extensions containing path separators (e.g., "/foo.d/bar").
  if (ext.includes("/") || ext.includes("\\")) return "";
  return ext;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TEXT_LEN) return trimmed;
  return trimmed.slice(0, MAX_TEXT_LEN - 1) + "…";
}

/**
 * Very rough token estimate mirroring the project-wide heuristic
 * (see src/core/token-estimator.ts). Duplicated here to avoid a hard
 * dependency in the hook hot-path.
 */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charEstimate = Math.ceil(text.length / 4);
  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / text.length;
  const adjustment = 1 - whitespaceRatio * 0.3;
  return Math.ceil(charEstimate * adjustment);
}

export function parseRegexSummary(
  content: string,
  filePath: string,
): HookSummary {
  const language = extractExtension(filePath);
  const totalLines = content.split("\n").length;
  const estimatedTokens = estimateTokens(content);

  const patterns = EXTENSIONS[language];
  if (!patterns) {
    return {
      signals: [],
      totalLines,
      estimatedTokens,
      language,
    };
  }

  const lines = content.split("\n");
  const signals: SignalLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;

    // Classification order: import → export → declaration. First match wins.
    let kind: SignalKind | null = null;
    if (patterns.import?.test(line)) {
      kind = "import";
    } else if (patterns.export?.test(line)) {
      kind = "export";
    } else if (patterns.declaration?.test(line)) {
      kind = "declaration";
    }

    if (kind !== null) {
      signals.push({
        line: i + 1,
        kind,
        text: truncate(line),
      });
    }
  }

  return {
    signals,
    totalLines,
    estimatedTokens,
    language,
  };
}
