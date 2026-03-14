import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative } from 'node:path';
import type { SmartLogArgs } from '../core/validation.js';

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface LogEntry {
  hash: string;
  date: string;
  author: string;
  message: string;
  category: 'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore' | 'style' | 'perf' | 'other';
  files: string[];
  insertions: number;
  deletions: number;
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const RECORD_SEPARATOR = '<<<SEP>>>';
const FIELD_SEPARATOR = '<<<F>>>';
const MAX_COUNT = 50;

// ──────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────

export async function handleSmartLog(
  args: SmartLogArgs,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; rawTokens: number }> {
  const count = Math.min(args.count ?? 10, MAX_COUNT);
  const ref = args.ref ?? 'HEAD';

  // Build git log command with --numstat for file stats
  const gitArgs = [
    'log',
    `--format=${RECORD_SEPARATOR}%h${FIELD_SEPARATOR}%ad${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%s`,
    '--date=short',
    '--numstat',
    `-${count}`,
    ref,
  ];

  if (args.path) {
    gitArgs.push('--', args.path);
  }

  let rawOutput: string;
  try {
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd: projectRoot,
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });
    rawOutput = stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `git log failed: ${msg}` }],
      rawTokens: 0,
    };
  }

  if (!rawOutput.trim()) {
    return {
      content: [{ type: 'text', text: 'No commits found.' }],
      rawTokens: 0,
    };
  }

  const rawTokens = estimateRawTokens(rawOutput);
  const entries = parseGitLog(rawOutput);
  const formatted = formatSmartLog(entries, args.path, projectRoot);

  return {
    content: [{ type: 'text', text: formatted }],
    rawTokens,
  };
}

// ──────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────

export function parseGitLog(raw: string): LogEntry[] {
  const records = raw.split(RECORD_SEPARATOR).filter(r => r.trim());
  const entries: LogEntry[] = [];

  for (const record of records) {
    const lines = record.trim().split('\n');
    if (lines.length === 0) continue;

    const headerLine = lines[0];
    const fields = headerLine.split(FIELD_SEPARATOR);
    if (fields.length < 4) continue;

    const [hash, date, author, message] = fields;

    // Parse numstat lines (insertions\tdeletions\tfile)
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        insertions += ins;
        deletions += del;
        files.push(parts[2]);
      }
    }

    entries.push({
      hash,
      date,
      author,
      message,
      category: categorizeCommit(message),
      files,
      insertions,
      deletions,
    });
  }

  return entries;
}

// ──────────────────────────────────────────────
// Categorizer
// ──────────────────────────────────────────────

export function categorizeCommit(message: string): LogEntry['category'] {
  const lower = message.toLowerCase();

  // Conventional commits prefix
  if (/^feat[:(!\s]/.test(lower)) return 'feat';
  if (/^fix[:(!\s]/.test(lower)) return 'fix';
  if (/^refactor[:(!\s]/.test(lower)) return 'refactor';
  if (/^docs?[:(!\s]/.test(lower)) return 'docs';
  if (/^tests?[:(!\s]/.test(lower)) return 'test';
  if (/^chore[:(!\s]/.test(lower)) return 'chore';
  if (/^style[:(!\s]/.test(lower)) return 'style';
  if (/^perf[:(!\s]/.test(lower)) return 'perf';

  // Version bumps
  if (/^v?\d+\.\d+/.test(lower)) return 'feat';

  // Keyword heuristics (order matters — more specific first)
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('patch') || lower.includes('hotfix')) return 'fix';
  if (lower.includes('test') || lower.includes('spec') || lower.includes('coverage')) return 'test';
  if (lower.includes('refactor') || lower.includes('restructure') || lower.includes('rename') || lower.includes('move') || lower.includes('extract')) return 'refactor';
  if (lower.includes('doc') || lower.includes('readme') || lower.includes('changelog')) return 'docs';
  if (lower.includes('add') || lower.includes('new') || lower.includes('implement') || lower.includes('feature')) return 'feat';
  if (lower.includes('style') || lower.includes('format') || lower.includes('lint')) return 'style';
  if (lower.includes('perf') || lower.includes('optim') || lower.includes('speed') || lower.includes('fast')) return 'perf';
  if (lower.includes('chore') || lower.includes('bump') || lower.includes('deps') || lower.includes('ci') || lower.includes('build')) return 'chore';

  return 'other';
}

// ──────────────────────────────────────────────
// Formatter
// ──────────────────────────────────────────────

function formatSmartLog(entries: LogEntry[], pathFilter: string | undefined, projectRoot: string): string {
  if (entries.length === 0) return 'No commits found.';

  const lines: string[] = [];

  // Header
  const filterInfo = pathFilter ? ` (filtered: ${pathFilter})` : '';
  lines.push(`GIT LOG: ${entries.length} commits${filterInfo}`);
  lines.push('');

  // Summary stats
  const authors = new Map<string, number>();
  const categories = new Map<string, number>();
  let totalIns = 0;
  let totalDel = 0;

  for (const e of entries) {
    authors.set(e.author, (authors.get(e.author) ?? 0) + 1);
    categories.set(e.category, (categories.get(e.category) ?? 0) + 1);
    totalIns += e.insertions;
    totalDel += e.deletions;
  }

  // Category summary
  const catParts: string[] = [];
  for (const [cat, count] of Array.from(categories.entries()).sort((a, b) => b[1] - a[1])) {
    catParts.push(`${cat}:${count}`);
  }
  lines.push(`BREAKDOWN: ${catParts.join(', ')} | +${totalIns}/-${totalDel} lines`);

  // Authors
  if (authors.size > 1) {
    const authorParts = Array.from(authors.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, cnt]) => `${name} (${cnt})`);
    lines.push(`AUTHORS: ${authorParts.join(', ')}`);
  }

  lines.push('');

  // Entries
  for (const e of entries) {
    const filesSummary = e.files.length <= 3
      ? e.files.join(', ')
      : `${e.files.slice(0, 3).join(', ')} +${e.files.length - 3} more`;

    const stats = e.insertions + e.deletions > 0
      ? ` (+${e.insertions}/-${e.deletions})`
      : '';

    lines.push(`${e.hash} ${e.date} [${e.category}] ${e.message}${stats}`);
    if (e.files.length > 0) {
      lines.push(`  → ${filesSummary}`);
    }
  }

  lines.push('');
  lines.push('HINT: Use smart_diff(scope="commit", ref="<hash>") to see structural changes for a specific commit.');

  return lines.join('\n');
}

function estimateRawTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
