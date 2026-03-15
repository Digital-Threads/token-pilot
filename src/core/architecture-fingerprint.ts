/**
 * Architecture fingerprint — caches project architecture data to a file
 * to amortize overview cost across sessions.
 * Track 8: Architecture Fingerprint
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ArchitectureFingerprint {
  version: string;
  generatedAt: number;
  projectType?: string;
  frameworks: string[];
  testLayout?: string;
  entrypoints: string[];
  moduleCount: number;
  sourceFileCount: number;
  namingConventions: string[];
}

const FINGERPRINT_FILE = '.token-pilot-fingerprint.json';
const FINGERPRINT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Load fingerprint from disk. Returns null if missing or expired.
 */
export async function loadFingerprint(projectRoot: string): Promise<ArchitectureFingerprint | null> {
  const filePath = join(projectRoot, FINGERPRINT_FILE);

  try {
    const fileStat = await stat(filePath);
    const age = Date.now() - fileStat.mtimeMs;

    if (age > FINGERPRINT_TTL_MS) {
      return null; // expired
    }

    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as ArchitectureFingerprint;

    // Validate minimal structure
    if (!data.version || !data.generatedAt) {
      return null;
    }

    return data;
  } catch {
    return null; // file doesn't exist or is invalid
  }
}

/**
 * Save fingerprint to disk.
 */
export async function saveFingerprint(
  projectRoot: string,
  fp: ArchitectureFingerprint,
): Promise<void> {
  const filePath = join(projectRoot, FINGERPRINT_FILE);
  await writeFile(filePath, JSON.stringify(fp, null, 2) + '\n', 'utf-8');
}

/**
 * Build fingerprint from project_overview text output.
 * Parses the structured overview text to extract key architecture data.
 */
export function buildFingerprint(
  overviewText: string,
  version: string,
): ArchitectureFingerprint {
  const fp: ArchitectureFingerprint = {
    version,
    generatedAt: Date.now(),
    frameworks: [],
    entrypoints: [],
    moduleCount: 0,
    sourceFileCount: 0,
    namingConventions: [],
  };

  // Extract project type
  const typeMatch = overviewText.match(/TYPE\s*(?:\([^)]*\))?:\s*(.+)/);
  if (typeMatch) {
    fp.projectType = typeMatch[1].trim().split('\n')[0];
  }

  // Extract frameworks
  const fwMatch = overviewText.match(/FRAMEWORKS:\s*(.+)/);
  if (fwMatch) {
    fp.frameworks = fwMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  // Extract file count from MAP or ast-index data
  const fileCountMatch = overviewText.match(/(\d+)\s*files/);
  if (fileCountMatch) {
    fp.sourceFileCount = parseInt(fileCountMatch[1], 10);
  }

  // Extract naming patterns
  const patternsMatch = overviewText.match(/PATTERNS:\s*(.+)/);
  if (patternsMatch) {
    fp.namingConventions = patternsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  // Extract architecture
  const archMatch = overviewText.match(/ARCHITECTURE:\s*(.+)/);
  if (archMatch) {
    fp.testLayout = archMatch[1].trim();
  }

  // Extract MAP entries as module indicators
  const mapEntries = overviewText.match(/^\s{2}\S+.*\(\d+ files/gm);
  if (mapEntries) {
    fp.moduleCount = mapEntries.length;
    // Detect entrypoints from common patterns
    for (const entry of mapEntries) {
      const dirMatch = entry.match(/^\s*(\S+)/);
      if (dirMatch) {
        const dir = dirMatch[1];
        if (/^(src|lib|app|main|index)/.test(dir)) {
          fp.entrypoints.push(dir);
        }
      }
    }
  }

  return fp;
}

/**
 * Format a cached fingerprint as a summary section.
 */
export function formatCachedFingerprint(fp: ArchitectureFingerprint): string {
  const lines: string[] = [
    '--- Cached Architecture (from previous session) ---',
  ];

  if (fp.projectType) {
    lines.push(`TYPE: ${fp.projectType}`);
  }
  if (fp.frameworks.length > 0) {
    lines.push(`FRAMEWORKS: ${fp.frameworks.join(', ')}`);
  }
  if (fp.sourceFileCount > 0) {
    lines.push(`FILES: ${fp.sourceFileCount}`);
  }
  if (fp.moduleCount > 0) {
    lines.push(`MODULES: ${fp.moduleCount}`);
  }
  if (fp.namingConventions.length > 0) {
    lines.push(`PATTERNS: ${fp.namingConventions.join(', ')}`);
  }
  if (fp.entrypoints.length > 0) {
    lines.push(`ENTRYPOINTS: ${fp.entrypoints.join(', ')}`);
  }

  const age = Date.now() - fp.generatedAt;
  const hoursAgo = Math.round(age / (60 * 60 * 1000));
  lines.push(`CACHED: ${hoursAgo}h ago (v${fp.version})`);
  lines.push('---');

  return lines.join('\n');
}
