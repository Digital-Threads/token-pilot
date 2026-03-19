/**
 * Token estimation functions for analytics.
 * Used to calculate "tokens would be" for honest savings reporting.
 */

import type { FileCache } from '../core/file-cache.js';
import type { SavingsCategory } from '../core/session-analytics.js';
import { estimateTokens } from '../core/token-estimator.js';
import { resolveSafePath } from '../core/validation.js';
import { CODE_EXTENSIONS } from '../handlers/outline.js';

/**
 * Creates token estimation functions bound to a project context.
 * Uses getter for projectRoot since it may change on auto-detect.
 */
export function createTokenEstimates(
  getProjectRoot: () => string,
  fileCache: FileCache,
) {
  async function fullFileTokens(relativePath: string): Promise<number> {
    try {
      const absPath = resolveSafePath(getProjectRoot(), relativePath);
      const cached = fileCache.get(absPath);
      if (cached) return estimateTokens(cached.content);
      const { readFile: readFileAsync } = await import('node:fs/promises');
      const content = await readFileAsync(absPath, 'utf-8');
      return estimateTokens(content);
    } catch {
      return 0;
    }
  }

  async function estimateProjectOverviewWorkflowTokens(
    includeSections: Array<'stack' | 'ci' | 'quality' | 'architecture'>,
  ): Promise<number> {
    const sectionFiles: Record<'stack' | 'ci' | 'quality' | 'architecture', string[]> = {
      stack: ['package.json', 'composer.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'],
      ci: ['.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml', 'bitbucket-pipelines.yml', '.travis.yml'],
      quality: [
        'tsconfig.json',
        'vitest.config.ts',
        'vitest.config.js',
        'vitest.config.mts',
        'jest.config.js',
        'jest.config.ts',
        'jest.config.mjs',
        'eslint.config.js',
        'eslint.config.mjs',
        '.eslintrc',
        '.eslintrc.js',
        '.eslintrc.json',
        '.eslintrc.yml',
        'biome.json',
        'biome.jsonc',
        '.prettierrc',
        '.prettierrc.js',
        '.prettierrc.json',
        'prettier.config.js',
        'phpunit.xml',
        'phpunit.xml.dist',
        'phpstan.neon',
        'phpstan.neon.dist',
      ],
      architecture: ['README.md'],
    };

    let total = 0;
    const seen = new Set<string>();
    for (const section of includeSections) {
      for (const file of sectionFiles[section]) {
        if (seen.has(file)) continue;
        seen.add(file);
        total += await fullFileTokens(file);
      }
    }

    if (includeSections.includes('ci')) {
      try {
        const { readdir: readDirAsync } = await import('node:fs/promises');
        const workflowDir = resolveSafePath(getProjectRoot(), '.github/workflows');
        const workflowFiles = await readDirAsync(workflowDir, { withFileTypes: true });
        for (const file of workflowFiles) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith('.yml') && !file.name.endsWith('.yaml')) continue;
          total += await fullFileTokens(`.github/workflows/${file.name}`);
        }
      } catch {
        // ignore missing workflows dir
      }
    }

    if (includeSections.includes('architecture')) {
      total += 200;
    }

    return total;
  }

  async function estimateOutlineWorkflowTokens(
    relativePath: string,
    recursive: boolean,
    maxDepth: number,
  ): Promise<number> {
    const SAMPLE_LIMIT = 30;

    try {
      const { readdir: readDirAsync } = await import('node:fs/promises');
      const { resolve: resolvePath } = await import('node:path');
      const absDir = resolveSafePath(getProjectRoot(), relativePath);
      const sampledFiles: string[] = [];
      let totalFiles = 0;

      async function walk(dirPath: string, depth: number): Promise<void> {
        const entries = await readDirAsync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
            if (!CODE_EXTENSIONS.has(ext)) continue;
            totalFiles++;
            if (sampledFiles.length < SAMPLE_LIMIT) {
              sampledFiles.push(resolvePath(dirPath, entry.name));
            }
            continue;
          }

          if (entry.isDirectory() && recursive && depth < maxDepth) {
            await walk(resolvePath(dirPath, entry.name), depth + 1);
          }
        }
      }

      await walk(absDir, 0);
      if (totalFiles === 0) return 0;

      let sampledTokens = 0;
      const projectRoot = getProjectRoot();
      for (const filePath of sampledFiles) {
        const relPath = filePath.startsWith(projectRoot)
          ? filePath.slice(projectRoot.length + 1)
          : filePath;
        sampledTokens += await fullFileTokens(relPath);
      }

      if (sampledFiles.length === 0 || sampledTokens === 0) return 0;
      if (sampledFiles.length === totalFiles) return sampledTokens;

      const averageTokens = sampledTokens / sampledFiles.length;
      return Math.round(averageTokens * totalFiles);
    } catch {
      return 0;
    }
  }

  async function estimateRelatedFilesWorkflowTokens(
    targetPath: string,
    meta?: { imports?: string[]; importedBy?: string[]; tests?: string[] },
  ): Promise<number> {
    const related = new Set<string>([targetPath]);
    for (const path of meta?.imports ?? []) related.add(path);
    for (const path of meta?.importedBy ?? []) related.add(path);
    for (const path of meta?.tests ?? []) related.add(path);

    let total = 0;
    let counted = 0;
    for (const path of related) {
      total += await fullFileTokens(path);
      counted++;
      if (counted >= 12) break;
    }
    return total;
  }

  async function estimateFindUsagesWorkflowTokens(files: string[]): Promise<number> {
    let total = 0;
    let counted = 0;
    for (const file of files) {
      total += await fullFileTokens(file);
      counted++;
      if (counted >= 20) break;
    }
    return total;
  }

  async function estimateExploreAreaWorkflowTokens(meta: {
    codeFiles?: string[];
    testFiles?: string[];
    internalDeps?: string[];
    importedBy?: string[];
    externalDeps?: string[];
    changeCount?: number;
  }): Promise<number> {
    const localFiles = new Set<string>();
    for (const file of meta.codeFiles ?? []) localFiles.add(file);
    for (const file of meta.testFiles ?? []) localFiles.add(file);
    for (const file of meta.internalDeps ?? []) localFiles.add(file);
    for (const file of meta.importedBy ?? []) localFiles.add(file);

    let total = 0;
    let counted = 0;
    for (const file of localFiles) {
      total += await fullFileTokens(file);
      counted++;
      if (counted >= 24) break;
    }

    total += (meta.externalDeps?.length ?? 0) * 30;
    total += (meta.changeCount ?? 0) * 40;
    return total;
  }

  function detectSavingsCategory(text: string): SavingsCategory {
    if (text.startsWith('REMINDER:') || text.startsWith('DEDUP:')) return 'dedup';
    return 'compression';
  }

  return {
    fullFileTokens,
    estimateProjectOverviewWorkflowTokens,
    estimateOutlineWorkflowTokens,
    estimateRelatedFilesWorkflowTokens,
    estimateFindUsagesWorkflowTokens,
    estimateExploreAreaWorkflowTokens,
    detectSavingsCategory,
  };
}
