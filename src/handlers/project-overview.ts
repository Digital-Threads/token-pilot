import { readFile } from 'node:fs/promises';
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

  // 1. Try to get ast-index stats
  try {
    const statsRaw = await astIndex.search('', { maxResults: 0 });
    // stats via the stats method is better
  } catch {
    // ignore
  }

  // 2. Read package.json / Cargo.toml etc. for project info
  const projectInfo = await detectProjectInfo(projectRoot);
  if (projectInfo) {
    lines.push(`Project: ${projectInfo.name} v${projectInfo.version}`);
    if (projectInfo.description) lines.push(`Description: ${projectInfo.description}`);
    lines.push(`Type: ${projectInfo.type}`);
    lines.push('');
  }

  // 3. Use ast-index map for compact project structure
  try {
    const mapResult = await execAstIndexMap(astIndex);
    if (mapResult) {
      lines.push('PROJECT MAP:');
      lines.push(mapResult);
      lines.push('');
    }
  } catch {
    // map not available
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

async function execAstIndexMap(astIndex: AstIndexClient): Promise<string | null> {
  // ast-index map returns a compact project structure
  // We access it via the internal exec by using search with empty query
  // Actually, we need to expose a map() method. For now, return null.
  // This will be enhanced when we expose more ast-index commands.
  return null;
}
