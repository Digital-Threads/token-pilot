/**
 * Benchmark: measure real token savings on public open-source repos.
 *
 * Usage: npx tsx scripts/benchmark.ts
 *
 * Tests Token Pilot's regex fallback parser (no ast-index binary needed)
 * on real files from express, fastify, flask, and token-pilot itself.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { parseTypeScriptRegex } from '../src/ast-index/regex-parser.js';
import { parsePythonRegex } from '../src/ast-index/regex-parser-python.js';
import { estimateTokens } from '../src/core/token-estimator.js';

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py']);

interface FileResult {
  path: string;
  lines: number;
  rawTokens: number;
  outlineTokens: number;
  savings: number; // percentage
  symbols: number;
}

interface RepoResult {
  name: string;
  files: FileResult[];
  totalRawTokens: number;
  totalOutlineTokens: number;
  totalSavings: number;
  avgSavings: number;
  fileCount: number;
}

function collectFiles(dir: string, exts: Set<string>, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__pycache__') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectFiles(fullPath, exts, maxDepth, depth + 1));
      } else if (entry.isFile() && exts.has(extname(entry.name).toLowerCase())) {
        try {
          const stat = statSync(fullPath);
          if (stat.size < 500000) files.push(fullPath); // skip huge files
        } catch { /* skip */ }
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return files;
}

function formatOutline(entries: Array<{ name: string; kind: string; start_line: number; end_line: number; signature?: string; children?: Array<{ name: string; kind: string; start_line: number; signature?: string }> }>): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`${e.kind} ${e.name} [${e.start_line}-${e.end_line}]${e.signature ? ': ' + e.signature.slice(0, 80) : ''}`);
    if (e.children) {
      for (const c of e.children) {
        lines.push(`  ${c.kind} ${c.name} [${c.start_line}]${c.signature ? ': ' + c.signature.slice(0, 60) : ''}`);
      }
    }
  }
  return lines.join('\n');
}

function benchmarkFile(filePath: string, repoRoot: string): FileResult | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    if (lines < 50) return null; // skip tiny files — Token Pilot returns them raw anyway

    const ext = extname(filePath).toLowerCase();
    const parser = TS_EXTS.has(ext) ? parseTypeScriptRegex : PY_EXTS.has(ext) ? parsePythonRegex : null;
    if (!parser) return null;

    const entries = parser(content);
    if (entries.length === 0) return null;

    const outline = formatOutline(entries);
    const rawTokens = estimateTokens(content);
    const outlineTokens = estimateTokens(outline);
    const savings = rawTokens > 0 ? Math.round((1 - outlineTokens / rawTokens) * 100) : 0;
    const symbols = entries.length + entries.reduce((s, e) => s + (e.children?.length ?? 0), 0);

    return {
      path: relative(repoRoot, filePath),
      lines,
      rawTokens,
      outlineTokens,
      savings,
      symbols,
    };
  } catch {
    return null;
  }
}

function benchmarkRepo(name: string, repoPath: string, exts: Set<string>): RepoResult {
  const files = collectFiles(repoPath, exts);
  const results: FileResult[] = [];

  for (const file of files) {
    const result = benchmarkFile(file, repoPath);
    if (result) results.push(result);
  }

  results.sort((a, b) => b.savings - a.savings);

  const totalRaw = results.reduce((s, r) => s + r.rawTokens, 0);
  const totalOutline = results.reduce((s, r) => s + r.outlineTokens, 0);
  const totalSavings = totalRaw > 0 ? Math.round((1 - totalOutline / totalRaw) * 100) : 0;
  const avgSavings = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.savings, 0) / results.length) : 0;

  return {
    name,
    files: results,
    totalRawTokens: totalRaw,
    totalOutlineTokens: totalOutline,
    totalSavings,
    avgSavings,
    fileCount: results.length,
  };
}

// --- Run benchmarks ---

const repos = [
  { name: 'token-pilot', path: '/Users/mhershahinyan/www/token-pilot/src', exts: TS_EXTS },
  { name: 'express', path: '/tmp/bench-repos/express/lib', exts: TS_EXTS },
  { name: 'fastify', path: '/tmp/bench-repos/fastify/lib', exts: TS_EXTS },
  { name: 'flask', path: '/tmp/bench-repos/flask/src/flask', exts: PY_EXTS },
];

console.log('='.repeat(80));
console.log('TOKEN PILOT BENCHMARK — Real token savings on public repos');
console.log('Parser: regex fallback (no ast-index binary)');
console.log('Files ≥50 lines only (smaller files returned raw by Token Pilot)');
console.log('='.repeat(80));
console.log('');

const allResults: RepoResult[] = [];

for (const repo of repos) {
  const result = benchmarkRepo(repo.name, repo.path, repo.exts);
  allResults.push(result);

  console.log(`--- ${result.name} (${result.fileCount} files) ---`);
  console.log(`Raw tokens: ${result.totalRawTokens.toLocaleString()}`);
  console.log(`Outline tokens: ${result.totalOutlineTokens.toLocaleString()}`);
  console.log(`Total savings: ${result.totalSavings}%`);
  console.log(`Avg per-file savings: ${result.avgSavings}%`);
  console.log('');

  // Top 5 files by savings
  console.log('Top files by savings:');
  for (const f of result.files.slice(0, 5)) {
    console.log(`  ${f.path} (${f.lines} lines, ${f.symbols} symbols): ${f.rawTokens} → ${f.outlineTokens} tokens (${f.savings}% saved)`);
  }

  // Worst 3 files
  const worst = result.files.slice(-3).reverse();
  if (worst.length > 0 && worst[0].savings < result.avgSavings) {
    console.log('Lowest savings:');
    for (const f of worst) {
      console.log(`  ${f.path} (${f.lines} lines): ${f.savings}% saved`);
    }
  }
  console.log('');
}

// Summary table
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log('');
console.log('| Repo | Files | Raw Tokens | Outline Tokens | Savings |');
console.log('|------|-------|------------|----------------|---------|');
for (const r of allResults) {
  console.log(`| ${r.name.padEnd(14)} | ${String(r.fileCount).padStart(5)} | ${r.totalRawTokens.toLocaleString().padStart(10)} | ${r.totalOutlineTokens.toLocaleString().padStart(14)} | ${String(r.totalSavings).padStart(5)}%  |`);
}

const grandRaw = allResults.reduce((s, r) => s + r.totalRawTokens, 0);
const grandOutline = allResults.reduce((s, r) => s + r.totalOutlineTokens, 0);
const grandSavings = grandRaw > 0 ? Math.round((1 - grandOutline / grandRaw) * 100) : 0;
const grandFiles = allResults.reduce((s, r) => s + r.fileCount, 0);
console.log(`| ${'TOTAL'.padEnd(14)} | ${String(grandFiles).padStart(5)} | ${grandRaw.toLocaleString().padStart(10)} | ${grandOutline.toLocaleString().padStart(14)} | ${String(grandSavings).padStart(5)}%  |`);
console.log('');
console.log('NOTE: This measures outline-only savings (smart_read structural view).');
console.log('Real sessions also benefit from: session cache, dedup reminders, read_symbol.');
