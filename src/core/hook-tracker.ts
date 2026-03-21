import { appendFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface DeniedRead {
  filePath: string;
  lineCount: number;
  estimatedTokens: number;
  timestamp: number;
}

function getDeniedReadsPath(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  return join(root, '.token-pilot', 'hook-denied.jsonl');
}

/**
 * Called from hook-read process when a Read is denied.
 * Appends to a shared JSONL file so the MCP server can read it.
 */
export function appendDeniedRead(
  filePath: string,
  lineCount: number,
  fileContent: string,
  projectRoot?: string,
): void {
  try {
    const charEstimate = Math.ceil(fileContent.length / 4);
    const whitespaceRatio = (fileContent.match(/\s/g)?.length ?? 0) / fileContent.length;
    const estimatedTokens = Math.ceil(charEstimate * (1 - whitespaceRatio * 0.3));

    const entry: DeniedRead = {
      filePath,
      lineCount,
      estimatedTokens,
      timestamp: Date.now(),
    };

    const outPath = getDeniedReadsPath(projectRoot);
    mkdirSync(join(outPath, '..'), { recursive: true });
    appendFileSync(outPath, JSON.stringify(entry) + '\n');
  } catch {
    // Silent fail — hook must not break
  }
}

/**
 * Called from MCP server to load denied reads for analytics.
 */
export function loadDeniedReads(projectRoot?: string): DeniedRead[] {
  try {
    const raw = readFileSync(getDeniedReadsPath(projectRoot), 'utf-8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as DeniedRead);
  } catch {
    return [];
  }
}

/**
 * Clear denied reads (called on session reset or after reporting).
 */
export function clearDeniedReads(projectRoot?: string): void {
  try {
    unlinkSync(getDeniedReadsPath(projectRoot));
  } catch {
    // File may not exist
  }
}
