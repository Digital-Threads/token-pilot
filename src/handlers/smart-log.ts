import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SmartLogArgs } from '../core/validation.js';
import { estimateTokens } from '../core/token-estimator.js';

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
    `-n`, `${count}`,
    '--', ref,
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

  const rawTokens = estimateTokens(rawOutput);
  const entries = parseGitLog(rawOutput);
  const formatted = formatSmartLog(entries, args.path);

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
        files.push(parts.slice(2).join('\t'));
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

  // Keyword heuristics with word boundaries (order matters — more specific first)
  if (/\b(fix|bug|hotfix)\b/.test(lower) || /\bpatch\b/.test(lower)) return 'fix';
  if (/\b(tests?|specs?|coverage)\b/.test(lower)) return 'test';
  if (/\b(refactor|restructure|rename|extract)\b/.test(lower) || /\bmove\b/.test(lower)) return 'refactor';
  if (/\b(docs?|documentation|readme|changelog)\b/.test(lower)) return 'docs';
  if (/\b(add|new|implement|feature)\b/.test(lower)) return 'feat';
  if (/\b(style|format|lint)\b/.test(lower)) return 'style';
  if (/\b(perf|optimiz\w*|speed|faster?)\b/.test(lower)) return 'perf';
  if (/\b(chore|bump|deps)\b/.test(lower) || /\bci\b/.test(lower) || /\bbuild\b/.test(lower)) return 'chore';

  return 'other';
}

// ──────────────────────────────────────────────
// Formatter
// ──────────────────────────────────────────────

function formatSmartLog(entries: LogEntry[], pathFilter: string | undefined): string {
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
  const authorParts = Array.from(authors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, cnt]) => authors.size > 1 ? `${name} (${cnt})` : name);
  lines.push(`AUTHORS: ${authorParts.join(', ')}`);

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

