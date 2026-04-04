import { readFile, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { relative, join, extname } from 'node:path';
import { parseMarkdownSections, findSection, extractSectionContent } from './markdown-sections.js';
import type { AstIndexClient } from '../ast-index/client.js';
import type { SymbolResolver } from '../core/symbol-resolver.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';
import { assessConfidence, formatConfidence } from '../core/confidence.js';

const execFileAsync = promisify(execFile);

export interface ReadForEditArgs {
  path: string;
  symbol?: string;
  symbols?: string[];
  line?: number;
  context?: number;
  include_callers?: boolean;
  include_tests?: boolean;
  include_changes?: boolean;
  section?: string;
}

const DEFAULT_CONTEXT = 5;

export async function handleReadForEdit(
  args: ReadForEditArgs,
  projectRoot: string,
  symbolResolver: SymbolResolver,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  astIndex: AstIndexClient,
  options?: { actionableHints?: boolean },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);
  const ctx = args.context ?? DEFAULT_CONTEXT;

  // Section mode: markdown section extraction for edit
  if (args.section) {
    const ext = extname(absPath).toLowerCase();
    if (ext !== '.md' && ext !== '.markdown') {
      return {
        content: [{
          type: 'text',
          text: `"section" parameter only works with Markdown files. Got: ${ext}. Use "symbol" for code files.`,
        }],
      };
    }

    const fileContent = await readFile(absPath, 'utf-8');
    const fileLines = fileContent.split('\n');
    const sections = parseMarkdownSections(fileContent);
    const section = findSection(sections, args.section);

    if (!section) {
      const available = sections.map(s => s.heading).join(', ');
      return {
        content: [{
          type: 'text',
          text: `Section "${args.section}" not found in ${args.path}.\nAvailable: ${available}`,
        }],
      };
    }

    // Cache file in fileCache for read_diff baseline
    if (!fileCache.get(absPath)) {
      const fileStat = await stat(absPath);
      const hash = createHash('sha256').update(fileContent).digest('hex');
      fileCache.set(absPath, {
        structure: { path: absPath, language: 'markdown', meta: { lines: fileLines.length, bytes: fileContent.length, lastModified: fileStat.mtimeMs, contentHash: hash }, imports: [], exports: [], symbols: [] },
        content: fileContent, lines: fileLines, mtime: fileStat.mtimeMs, hash, lastAccess: Date.now(),
      });
    }

    const rawContent = extractSectionContent(fileLines, section);
    const hashes = '#'.repeat(section.level);

    const outputLines: string[] = [
      `FILE: ${args.path}`,
      `EDIT SECTION: ${hashes} ${section.heading} [L${section.startLine}-${section.endLine}] (${section.lineCount} lines)`,
      '',
      rawContent,
      '',
      `AFTER EDIT: Use read_diff("${args.path}") to verify changes (90% cheaper than re-reading).`,
    ];

    const output = outputLines.join('\n');
    const tokens = estimateTokens(output);

    contextRegistry.trackLoad(absPath, {
      type: 'range',
      startLine: section.startLine,
      endLine: section.endLine,
      tokens,
    });

    return { content: [{ type: 'text', text: output }] };
  }

  // Get file content — also cache for read_diff baseline
  const cached = fileCache.get(absPath);
  let lines: string[];

  if (cached) {
    lines = cached.lines;
  } else {
    const content = await readFile(absPath, 'utf-8');
    lines = content.split('\n');

    // Cache the full file so read_diff can use it as baseline after edits
    const fileStat = await stat(absPath);
    const hash = createHash('sha256').update(content).digest('hex');
    fileCache.set(absPath, {
      structure: {
        path: absPath,
        language: 'unknown',
        meta: { lines: lines.length, bytes: content.length, lastModified: fileStat.mtimeMs, contentHash: hash },
        imports: [],
        exports: [],
        symbols: [],
      },
      content,
      lines,
      mtime: fileStat.mtimeMs,
      hash,
      lastAccess: Date.now(),
    });
  }

  // --- Batch mode: multiple symbols ---
  if (args.symbols && args.symbols.length > 0) {
    let structure = cached?.structure;
    if (!structure) {
      structure = await astIndex.outline(absPath) ?? undefined;
    }

    const sections: string[] = [];
    sections.push(`--- EDIT CONTEXT (BATCH: ${args.symbols.length} symbols) ---`);
    sections.push(`FILE: ${args.path}`);
    sections.push('');

    let resolved_count = 0;
    for (let i = 0; i < args.symbols.length; i++) {
      const symName = args.symbols[i];
      const resolved = await symbolResolver.resolve(symName, structure);

      if (!resolved) {
        sections.push(`=== SYMBOL ${i + 1}/${args.symbols.length}: ${symName} — NOT FOUND ===`);
        sections.push('');
        continue;
      }

      resolved_count++;
      const symbolLines = resolved.endLine - resolved.startLine + 1;
      const MAX_EDIT_LINES = 60;

      let effStart = resolved.startLine;
      let effEnd: number;
      let label: string;

      if (symbolLines <= MAX_EDIT_LINES) {
        effEnd = resolved.endLine;
        label = `${symName} [L${effStart}-${effEnd}] (${symbolLines} lines, full)`;
      } else {
        effEnd = effStart + MAX_EDIT_LINES - 1;
        label = `${symName} [L${effStart}-${resolved.endLine}] (showing first ${MAX_EDIT_LINES} of ${symbolLines} lines)`;
      }

      const rangeStart = Math.max(1, effStart - ctx);
      const rangeEnd = Math.min(lines.length, effEnd + ctx);
      const rawCode = lines.slice(rangeStart - 1, rangeEnd).join('\n');

      sections.push(`=== SYMBOL ${i + 1}/${args.symbols.length}: ${label} ===`);
      sections.push('');
      sections.push(rawCode);
      sections.push('');

      // Track each symbol
      contextRegistry.trackLoad(absPath, {
        type: 'symbol',
        symbolName: symName,
        startLine: rangeStart,
        endLine: rangeEnd,
        tokens: estimateTokens(rawCode),
      });
    }

    sections.push('--- END EDIT CONTEXT ---');
    sections.push('');
    sections.push(`To edit: use exact text from each section as old_string in Edit tool.`);
    if (resolved_count < args.symbols.length) {
      sections.push(`WARNING: ${args.symbols.length - resolved_count} symbol(s) not found. Use smart_read to see available symbols.`);
    }

    const confidenceMeta = assessConfidence({
      symbolResolved: resolved_count > 0,
      fullFile: false,
      truncated: false,
      astAvailable: true,
    });
    sections.push(formatConfidence(confidenceMeta));

    const output = sections.join('\n');
    return { content: [{ type: 'text', text: output }] };
  }

  let startLine: number;
  let endLine: number;
  let targetLabel: string;

  if (args.symbol) {
    // Resolve symbol via AST
    let structure = cached?.structure;
    if (!structure) {
      structure = await astIndex.outline(absPath) ?? undefined;
    }
    const resolved = await symbolResolver.resolve(args.symbol, structure);

    if (!resolved) {
      return {
        content: [{
          type: 'text',
          text: `Symbol "${args.symbol}" not found in ${args.path}.\nHINT: Use smart_read("${args.path}") to see available symbols.`,
        }],
      };
    }

    const symbolLines = resolved.endLine - resolved.startLine + 1;
    const MAX_EDIT_LINES = 60;

    startLine = resolved.startLine;

    if (symbolLines <= MAX_EDIT_LINES) {
      endLine = resolved.endLine;
      targetLabel = `${args.symbol} [L${startLine}-${endLine}] (${symbolLines} lines, full)`;
    } else {
      endLine = startLine + MAX_EDIT_LINES - 1;
      targetLabel = `${args.symbol} [L${startLine}-${resolved.endLine}] (showing first ${MAX_EDIT_LINES} of ${symbolLines} lines)`;
    }
  } else if (args.line) {
    if (args.line < 1 || args.line > lines.length) {
      return {
        content: [{
          type: 'text',
          text: `Line ${args.line} out of range (file has ${lines.length} lines).`,
        }],
      };
    }
    startLine = args.line;
    endLine = args.line;
    targetLabel = `line ${args.line}`;
  } else {
    return {
      content: [{
        type: 'text',
        text: 'Either "symbol" or "line" must be provided.',
      }],
    };
  }

  // Apply context padding
  const rangeStart = Math.max(1, startLine - ctx);
  const rangeEnd = Math.min(lines.length, endLine + ctx);
  const rangeCount = rangeEnd - rangeStart + 1;

  // Extract RAW code (no line number prefixes — ready for Edit old_string)
  const rawCode = lines.slice(rangeStart - 1, rangeEnd).join('\n');

  const outputLines = [
    `--- EDIT CONTEXT ---`,
    `FILE: ${args.path}`,
    `TARGET: ${targetLabel}`,
    `SHOWING: L${rangeStart}-${rangeEnd} (${rangeCount} lines)`,
    '',
    rawCode,
    '',
    `--- END EDIT CONTEXT ---`,
    '',
    `To edit: use exact text above as old_string in Edit tool.`,
    `For Read requirement: Read("${args.path}", offset=${rangeStart}, limit=${rangeCount})`,
  ];

  // --- Optional enrichment sections ---

  // include_callers: compact caller list via ast-index refs
  if (args.include_callers && args.symbol && !astIndex.isDisabled()) {
    try {
      const refs = await astIndex.refs(args.symbol, 10);
      const callers = refs.usages.slice(0, 5);
      if (callers.length > 0) {
        outputLines.push('');
        outputLines.push(`CALLERS (${callers.length}):`);
        for (const c of callers) {
          const relPath = relative(projectRoot, c.path);
          const ctx = c.context ? ` — ${c.context.trim().slice(0, 80)}` : '';
          outputLines.push(`  ${relPath}:${c.line}${ctx}`);
        }
      } else {
        outputLines.push('');
        outputLines.push('CALLERS: none found');
      }
    } catch {
      // ast-index unavailable — skip silently
    }
  }

  // include_tests: find related test file and list test names
  if (args.include_tests) {
    const testSection = await findTestSection(absPath, args.path, projectRoot, astIndex);
    outputLines.push('');
    outputLines.push(...testSection);
  }

  // include_changes: git diff filtered to target region
  if (args.include_changes) {
    const diffSection = await findChangesSection(absPath, projectRoot, rangeStart, rangeEnd);
    outputLines.push('');
    outputLines.push(...diffSection);
  }

  // Confidence metadata
  const confidenceMeta = assessConfidence({
    symbolResolved: !!args.symbol && startLine > 0,
    fullFile: false,
    truncated: false,
    hasCallers: args.include_callers ?? false,
    hasTests: args.include_tests ?? false,
    astAvailable: true,
  });
  outputLines.push(formatConfidence(confidenceMeta));

  // Add post-edit hint (config-gated)
  if (options?.actionableHints !== false) {
    outputLines.push('');
    outputLines.push(`AFTER EDIT: Use read_diff("${args.path}") to verify changes (90% cheaper than re-reading the file).`);
  }

  const output = outputLines.join('\n');
  const tokens = estimateTokens(output);

  // Track in context
  contextRegistry.trackLoad(absPath, {
    type: 'symbol',
    symbolName: args.symbol ?? `line:${args.line}`,
    startLine: rangeStart,
    endLine: rangeEnd,
    tokens,
  });

  return { content: [{ type: 'text', text: output }] };
}

// --- Helper: find related test file and extract test names ---

async function findTestSection(
  absPath: string,
  relPath: string,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<string[]> {
  // Derive test file path from source path using common conventions
  // src/handlers/foo.ts → tests/handlers/foo.test.ts
  // src/core/bar.ts → tests/core/bar.test.ts
  const srcPrefix = 'src/';
  let testRelPath: string;

  if (relPath.startsWith(srcPrefix)) {
    const rest = relPath.slice(srcPrefix.length);
    const ext = rest.match(/\.[^.]+$/)?.[0] ?? '.ts';
    const base = rest.replace(/\.[^.]+$/, '');
    testRelPath = `tests/${base}.test${ext}`;
  } else {
    const ext = relPath.match(/\.[^.]+$/)?.[0] ?? '.ts';
    const base = relPath.replace(/\.[^.]+$/, '');
    testRelPath = `${base}.test${ext}`;
  }

  const testAbsPath = join(projectRoot, testRelPath);

  try {
    await access(testAbsPath);
  } catch {
    return [`TESTS: none found (expected at ${testRelPath})`];
  }

  // Test file exists — try to get outline for test names
  const lines: string[] = [`TESTS: ${testRelPath}`];

  if (!astIndex.isDisabled()) {
    try {
      const outline = await astIndex.outline(testAbsPath);
      if (outline?.symbols && outline.symbols.length > 0) {
        for (const sym of outline.symbols) {
          lines.push(`  ${sym.kind} ${sym.name}`);
          if (sym.children) {
            for (const child of sym.children) {
              lines.push(`    ${child.kind} ${child.name}`);
            }
          }
        }
      }
    } catch {
      // outline failed — just show file path
    }
  }

  return lines;
}

// --- Helper: git diff filtered to target region ---

async function findChangesSection(
  absPath: string,
  projectRoot: string,
  rangeStart: number,
  rangeEnd: number,
): Promise<string[]> {
  const MAX_DIFF_LINES = 30;

  try {
    // Try unstaged changes first
    let diffOutput = '';
    let diffLabel = 'unstaged';

    try {
      const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--', absPath], {
        cwd: projectRoot,
        timeout: 5000,
      });
      diffOutput = stdout;
    } catch {
      // git not available or not a repo
      return ['RECENT CHANGES: unavailable (not a git repo)'];
    }

    // If no unstaged changes, try last commit
    if (!diffOutput.trim()) {
      try {
        const { stdout } = await execFileAsync('git', ['diff', 'HEAD~1', '--', absPath], {
          cwd: projectRoot,
          timeout: 5000,
        });
        diffOutput = stdout;
        diffLabel = 'last commit';
      } catch {
        // no previous commit
      }
    }

    if (!diffOutput.trim()) {
      return ['RECENT CHANGES: none (file unchanged)'];
    }

    // Filter hunks to those overlapping with target range
    const relevantLines = filterDiffHunks(diffOutput, rangeStart, rangeEnd);

    if (relevantLines.length === 0) {
      return ['RECENT CHANGES: none in target region'];
    }

    const lines: string[] = [`RECENT CHANGES (${diffLabel}):`];
    const trimmed = relevantLines.slice(0, MAX_DIFF_LINES);
    for (const line of trimmed) {
      lines.push(`  ${line}`);
    }
    if (relevantLines.length > MAX_DIFF_LINES) {
      lines.push(`  ... ${relevantLines.length - MAX_DIFF_LINES} more lines`);
    }
    return lines;
  } catch {
    return ['RECENT CHANGES: unavailable'];
  }
}

/** Filter diff output to only hunks overlapping [rangeStart, rangeEnd]. */
function filterDiffHunks(diff: string, rangeStart: number, rangeEnd: number): string[] {
  const allLines = diff.split('\n');
  const result: string[] = [];
  let inRelevantHunk = false;

  for (const line of allLines) {
    // Hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const hunkStart = parseInt(hunkMatch[1], 10);
      const hunkLen = parseInt(hunkMatch[2] ?? '1', 10);
      const hunkEnd = hunkStart + hunkLen - 1;
      // Check overlap with target range
      inRelevantHunk = hunkStart <= rangeEnd && hunkEnd >= rangeStart;
      if (inRelevantHunk) {
        result.push(line);
      }
      continue;
    }

    // Skip diff metadata lines (diff --git, index, ---, +++)
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    if (inRelevantHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      result.push(line);
    }
  }

  return result;
}
