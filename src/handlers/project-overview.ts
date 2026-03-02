import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';

export async function handleProjectOverview(
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const lines: string[] = [];

  // 1. Project info from package.json / Cargo.toml etc.
  const projectInfo = await detectProjectInfo(projectRoot);
  if (projectInfo) {
    lines.push(`PROJECT: ${projectInfo.name} v${projectInfo.version}`);
    if (projectInfo.description) lines.push(`  ${projectInfo.description}`);
    lines.push('');
  } else {
    lines.push(`PROJECT: ${basename(projectRoot)}`);
    lines.push('');
  }

  // 2. ast-index map — directory structure with file counts and symbol kinds
  if (astIndex.isAvailable()) {
    const [mapData, convData] = await Promise.all([
      astIndex.map(),
      astIndex.conventions(),
    ]);

    if (mapData) {
      lines.push(`TYPE: ${mapData.project_type} (${mapData.file_count} files)`);
      lines.push('');

      // Conventions
      if (convData) {
        if (convData.architecture.length > 0) {
          lines.push(`ARCHITECTURE: ${convData.architecture.join(', ')}`);
        }

        const fwList: string[] = [];
        for (const [category, frameworks] of Object.entries(convData.frameworks)) {
          for (const fw of frameworks) {
            fwList.push(`${fw.name} (${category})`);
          }
        }
        if (fwList.length > 0) {
          lines.push(`FRAMEWORKS: ${fwList.join(', ')}`);
        }

        if (convData.naming_patterns.length > 0) {
          const patterns = convData.naming_patterns
            .slice(0, 8)
            .map(p => `${p.suffix}(${p.count})`)
            .join(', ');
          lines.push(`PATTERNS: ${patterns}`);
        }
        lines.push('');
      }

      // Directory map
      lines.push('MAP:');
      for (const group of mapData.groups) {
        const kinds = group.kinds
          ? ' — ' + Object.entries(group.kinds).map(([k, v]) => `${v} ${k}`).join(', ')
          : '';
        lines.push(`  ${group.path} (${group.file_count} files${kinds})`);
      }
      lines.push('');
    } else {
      // Fallback to stats
      try {
        const statsText = await astIndex.stats();
        if (statsText) {
          const filesMatch = statsText.match(/Files:\s*(\d+)/);
          const symbolsMatch = statsText.match(/Symbols:\s*(\d+)/);
          if (filesMatch) lines.push(`Files indexed: ${filesMatch[1]}`);
          if (symbolsMatch) lines.push(`Symbols: ${symbolsMatch[1]}`);
          lines.push('');
        }
      } catch { /* ignore */ }
    }
  }

  lines.push('HINT: Use smart_read() on files, find_usages() for symbol references, outline() for directory overview.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

interface ProjectInfo {
  name: string;
  version: string;
  description?: string;
  type: string;
}

async function detectProjectInfo(projectRoot: string): Promise<ProjectInfo | null> {
  try {
    const pkg = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf-8'));
    return {
      name: pkg.name ?? basename(projectRoot),
      version: pkg.version ?? '0.0.0',
      description: pkg.description,
      type: 'Node.js/TypeScript',
    };
  } catch { /* not a node project */ }

  try {
    const composer = JSON.parse(await readFile(resolve(projectRoot, 'composer.json'), 'utf-8'));
    return {
      name: composer.name ?? 'unknown',
      version: composer.version ?? '0.0.0',
      description: composer.description,
      type: 'PHP',
    };
  } catch { /* not a php project */ }

  try {
    const cargo = await readFile(resolve(projectRoot, 'Cargo.toml'), 'utf-8');
    const name = cargo.match(/^name\s*=\s*"(.+?)"/m)?.[1] ?? 'unknown';
    const version = cargo.match(/^version\s*=\s*"(.+?)"/m)?.[1] ?? '0.0.0';
    return { name, version, type: 'Rust' };
  } catch { /* not a rust project */ }

  try {
    const pyproject = await readFile(resolve(projectRoot, 'pyproject.toml'), 'utf-8');
    const name = pyproject.match(/^name\s*=\s*"(.+?)"/m)?.[1] ?? 'unknown';
    const version = pyproject.match(/^version\s*=\s*"(.+?)"/m)?.[1] ?? '0.0.0';
    return { name, version, type: 'Python' };
  } catch { /* not a python project */ }

  try {
    const gomod = await readFile(resolve(projectRoot, 'go.mod'), 'utf-8');
    const name = gomod.match(/^module\s+(.+)/m)?.[1] ?? 'unknown';
    return { name, version: '0.0.0', type: 'Go' };
  } catch { /* not a go project */ }

  return null;
}
