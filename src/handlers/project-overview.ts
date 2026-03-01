import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';

export async function handleProjectOverview(
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const lines: string[] = [
    `PROJECT OVERVIEW: ${projectRoot}`,
    '',
  ];

  // 1. Read package.json / Cargo.toml etc. for project info
  const projectInfo = await detectProjectInfo(projectRoot);
  if (projectInfo) {
    lines.push(`Project: ${projectInfo.name} v${projectInfo.version}`);
    if (projectInfo.description) lines.push(`Description: ${projectInfo.description}`);
    lines.push(`Type: ${projectInfo.type}`);
    lines.push('');
  }

  // 2. Top-level directory listing
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .sort();
    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();

    if (dirs.length > 0 || files.length > 0) {
      lines.push('STRUCTURE:');
      for (const d of dirs) {
        lines.push(`  ${d}/`);
      }
      for (const f of files.slice(0, 15)) {
        lines.push(`  ${f}`);
      }
      if (files.length > 15) {
        lines.push(`  ... and ${files.length - 15} more files`);
      }
      lines.push('');
    }
  } catch { /* ignore */ }

  // 3. ast-index stats (indexed files, languages)
  if (astIndex.isAvailable()) {
    try {
      const statsText = await astIndex.stats();
      if (statsText) {
        const filesMatch = statsText.match(/Files:\s*(\d+)/);
        const symbolsMatch = statsText.match(/Symbols:\s*(\d+)/);
        const refsMatch = statsText.match(/Refs:\s*(\d+)/);
        const projectType = statsText.match(/Project:\s*(.+)/);

        lines.push('INDEX:');
        if (projectType) lines.push(`  Detected: ${projectType[1].trim()}`);
        if (filesMatch) lines.push(`  Files indexed: ${filesMatch[1]}`);
        if (symbolsMatch) lines.push(`  Symbols: ${symbolsMatch[1]}`);
        if (refsMatch) lines.push(`  References: ${refsMatch[1]}`);
        lines.push('');
      }
    } catch { /* ast-index stats not available */ }
  }

  lines.push('HINT: Use smart_read() on individual files, or search_code() to find specific symbols.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

interface ProjectInfo {
  name: string;
  version: string;
  description?: string;
  type: string;
}

async function detectProjectInfo(projectRoot: string): Promise<ProjectInfo | null> {
  // Try package.json
  try {
    const pkg = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf-8'));
    return {
      name: pkg.name ?? 'unknown',
      version: pkg.version ?? '0.0.0',
      description: pkg.description,
      type: 'Node.js/TypeScript',
    };
  } catch { /* not a node project */ }

  // Try composer.json (PHP)
  try {
    const composer = JSON.parse(await readFile(resolve(projectRoot, 'composer.json'), 'utf-8'));
    return {
      name: composer.name ?? 'unknown',
      version: composer.version ?? '0.0.0',
      description: composer.description,
      type: 'PHP',
    };
  } catch { /* not a php project */ }

  // Try Cargo.toml
  try {
    const cargo = await readFile(resolve(projectRoot, 'Cargo.toml'), 'utf-8');
    const name = cargo.match(/^name\s*=\s*"(.+?)"/m)?.[1] ?? 'unknown';
    const version = cargo.match(/^version\s*=\s*"(.+?)"/m)?.[1] ?? '0.0.0';
    return { name, version, type: 'Rust' };
  } catch { /* not a rust project */ }

  // Try pyproject.toml
  try {
    const pyproject = await readFile(resolve(projectRoot, 'pyproject.toml'), 'utf-8');
    const name = pyproject.match(/^name\s*=\s*"(.+?)"/m)?.[1] ?? 'unknown';
    const version = pyproject.match(/^version\s*=\s*"(.+?)"/m)?.[1] ?? '0.0.0';
    return { name, version, type: 'Python' };
  } catch { /* not a python project */ }

  // Try go.mod
  try {
    const gomod = await readFile(resolve(projectRoot, 'go.mod'), 'utf-8');
    const name = gomod.match(/^module\s+(.+)/m)?.[1] ?? 'unknown';
    return { name, version: '0.0.0', type: 'Go' };
  } catch { /* not a go project */ }

  return null;
}
