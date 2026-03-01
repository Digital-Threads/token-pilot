import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import { estimateTokens, formatSavings } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';

export interface ReadDiffArgs {
  path: string;
  context_lines?: number;
}

export async function handleReadDiff(
  args: ReadDiffArgs,
  projectRoot: string,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const absPath = resolveSafePath(projectRoot, args.path);
  const contextLines = args.context_lines ?? 3;

  // Get cached (previous) version
  const cached = fileCache.get(absPath);

  if (!cached) {
    return {
      content: [{
        type: 'text',
        text: `No previous read of ${args.path}. Use smart_read() first, then read_diff() after changes.`,
      }],
    };
  }

  // Read current version
  const currentContent = await readFile(absPath, 'utf-8');
  const currentHash = createHash('sha256').update(currentContent).digest('hex');

  // No changes?
  if (currentHash === cached.hash) {
    return {
      content: [{
        type: 'text',
        text: `NO CHANGES: ${args.path} is unchanged since last read.`,
      }],
    };
  }

  // Compute diff
  const oldLines = cached.lines;
  const newLines = currentContent.split('\n');
  const diff = computeDiff(oldLines, newLines, contextLines);

  const outputLines: string[] = [
    `DIFF: ${args.path} (modified since last read)`,
    `PREVIOUS: ${cached.hash.slice(0, 7)} → CURRENT: ${currentHash.slice(0, 7)}`,
    '',
    ...diff,
  ];

  const output = outputLines.join('\n');
  const diffTokens = estimateTokens(output);
  const fullTokens = estimateTokens(currentContent);

  outputLines.push('');
  outputLines.push(formatSavings(diffTokens, fullTokens));

  // Update cache with new content so next diff works correctly
  const fileStat = await stat(absPath);
  fileCache.set(absPath, {
    structure: cached.structure, // reuse structure until next smart_read
    content: currentContent,
    lines: newLines,
    mtime: fileStat.mtimeMs,
    hash: currentHash,
    lastAccess: Date.now(),
  });

  // Update context registry hash
  contextRegistry.setContentHash(absPath, currentHash);

  return { content: [{ type: 'text', text: outputLines.join('\n') }] };
}

/**
 * O(n) line diff using a Map for lookups instead of Array.includes().
 * Groups consecutive changes into hunks with surrounding context.
 */
function computeDiff(
  oldLines: string[],
  newLines: string[],
  contextLines: number,
): string[] {
  // Build a set of line -> positions in newLines for O(1) lookup
  const newLineIndex = new Map<string, number[]>();
  for (let i = 0; i < newLines.length; i++) {
    const positions = newLineIndex.get(newLines[i]);
    if (positions) {
      positions.push(i);
    } else {
      newLineIndex.set(newLines[i], [i]);
    }
  }

  // Walk both arrays, matching lines greedily
  const changes: Array<{ type: 'same' | 'removed' | 'added'; line: string; oldNum?: number; newNum?: number }> = [];
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      changes.push({ type: 'same', line: newLines[ni], oldNum: oi + 1, newNum: ni + 1 });
      oi++;
      ni++;
    } else if (oi < oldLines.length && !newLineIndex.has(oldLines[oi])) {
      // Line only exists in old — it was removed
      changes.push({ type: 'removed', line: oldLines[oi], oldNum: oi + 1 });
      oi++;
    } else if (ni < newLines.length) {
      // Check if the old line exists later in new (i.e., we need to consume added lines first)
      const oldLinePositions = oi < oldLines.length ? newLineIndex.get(oldLines[oi]) : undefined;
      if (oldLinePositions && oldLinePositions.some(p => p >= ni)) {
        // Old line will match later — current newLine is added
        changes.push({ type: 'added', line: newLines[ni], newNum: ni + 1 });
        ni++;
      } else if (oi < oldLines.length) {
        // Old line not found ahead — it's removed
        changes.push({ type: 'removed', line: oldLines[oi], oldNum: oi + 1 });
        oi++;
      } else {
        // Only new lines remain
        changes.push({ type: 'added', line: newLines[ni], newNum: ni + 1 });
        ni++;
      }
    } else {
      // Only old lines remain
      changes.push({ type: 'removed', line: oldLines[oi], oldNum: oi + 1 });
      oi++;
    }
  }

  // Format with context hunks
  return formatHunks(changes, contextLines);
}

function formatHunks(
  changes: Array<{ type: 'same' | 'removed' | 'added'; line: string; oldNum?: number; newNum?: number }>,
  contextLines: number,
): string[] {
  const output: string[] = [];

  // Find change indices
  const changeIndices: number[] = [];
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].type !== 'same') changeIndices.push(i);
  }

  if (changeIndices.length === 0) {
    return ['(No textual differences detected)'];
  }

  // Build hunks (groups of nearby changes)
  const printed = new Set<number>();

  for (const ci of changeIndices) {
    // Context before
    for (let j = Math.max(0, ci - contextLines); j < ci; j++) {
      if (!printed.has(j) && changes[j].type === 'same') {
        const num = changes[j].newNum ?? changes[j].oldNum ?? 0;
        output.push(`  ${String(num).padStart(4)} | ${changes[j].line}`);
        printed.add(j);
      }
    }

    // The change itself
    if (!printed.has(ci)) {
      const c = changes[ci];
      if (c.type === 'removed') {
        output.push(`- ${String(c.oldNum ?? 0).padStart(4)} | ${c.line}`);
      } else {
        output.push(`+ ${String(c.newNum ?? 0).padStart(4)} | ${c.line}`);
      }
      printed.add(ci);
    }

    // Context after
    let afterCount = 0;
    for (let j = ci + 1; j < changes.length && afterCount < contextLines; j++) {
      if (changes[j].type === 'same') {
        if (!printed.has(j)) {
          const num = changes[j].newNum ?? changes[j].oldNum ?? 0;
          output.push(`  ${String(num).padStart(4)} | ${changes[j].line}`);
          printed.add(j);
        }
        afterCount++;
      } else {
        break; // Next change will be handled in its own iteration
      }
    }

    // Add separator if there's a gap to the next change
    const nextChangeIdx = changeIndices[changeIndices.indexOf(ci) + 1];
    if (nextChangeIdx !== undefined && nextChangeIdx - ci > contextLines * 2 + 1) {
      output.push('  ...');
    }
  }

  return output;
}
