import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleProjectOverview } from '../../src/handlers/project-overview.js';

describe('handleProjectOverview', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-overview-'));
    await mkdir(join(tempDir, '.github'));
    await mkdir(join(tempDir, '.github', 'workflows'));
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'demo-app',
      version: '1.2.3',
      description: 'Demo project',
      dependencies: { react: '^19.0.0' },
      devDependencies: { vitest: '^3.0.0' },
      engines: { node: '>=20' },
    }, null, 2));
    await writeFile(join(tempDir, 'tsconfig.json'), '{}');
    await writeFile(join(tempDir, 'vitest.config.ts'), 'export default {};\n');
    await writeFile(join(tempDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds an overview from config files and ast metadata', async () => {
    const astIndex = {
      isAvailable: () => true,
      isOversized: () => false,
      isDisabled: () => false,
      map: async () => ({
        project_type: 'typescript',
        file_count: 3,
        groups: [{ path: 'src', file_count: 3, kinds: { function: 4 } }],
      }),
      conventions: async () => ({
        architecture: ['layered'],
        frameworks: { frontend: [{ name: 'React', count: 3 }] },
        naming_patterns: [{ suffix: 'Service', count: 2 }],
      }),
      stats: async () => null,
    } as any;

    const result = await handleProjectOverview({}, tempDir, astIndex);
    const text = result.content[0].text;

    expect(text).toContain('PROJECT: demo-app v1.2.3');
    expect(text).toContain('TYPE (ast-index): typescript (3 files)');
    expect(text).toContain('QUALITY: TypeScript, Vitest');
    expect(text).toContain('CI: GitHub Actions (1 workflow)');
    expect(text).toContain('ARCHITECTURE: layered');
    expect(text).toContain('MAP:');
  });

  it('says when the MAP is capped and when ast-index conventions were skipped', async () => {
    const astIndex = {
      isAvailable: () => true,
      isOversized: () => false,
      isDisabled: () => false,
      map: async () => ({
        project_type: 'typescript',
        file_count: 293,
        showing: 1,
        total_dirs: 53,
        groups: [{ path: 'src/handlers/', file_count: 30 }],
      }),
      conventions: async () => ({
        architecture: ['Hooks pattern'],
        frameworks: {},
        naming_patterns: [],
        vendored_skipped: true,
      }),
      stats: async () => null,
    } as any;

    const text = (await handleProjectOverview({}, tempDir, astIndex)).content[0].text;

    expect(text).toContain('MAP (1 of 53 directories):');
    expect(text).toMatch(/frameworks and naming patterns.*node_modules/);
    expect(text).not.toContain('PATTERNS:');
  });

  describe('architecture fingerprint', () => {
    const fpPath = () => join(tempDir, '.token-pilot-fingerprint.json');
    const astIndex = (fileCount = 293) => ({
      isAvailable: () => true,
      isOversized: () => false,
      isDisabled: () => false,
      // The real `map --format json` has no project_type.
      map: async () => ({
        file_count: fileCount,
        showing: 1,
        total_dirs: 1,
        groups: [{ path: 'src/', file_count: 35 }],
      }),
      conventions: async () => ({ architecture: [], frameworks: {}, naming_patterns: [] }),
      stats: async () => null,
    }) as any;

    it('is rebuilt from the fresh overview, not from the cached block it printed', async () => {
      await writeFile(fpPath(), JSON.stringify({
        version: '0.1', generatedAt: Date.now(), projectType: 'OLD (999 files)',
        frameworks: ['Rx (Async)'], entrypoints: [], moduleCount: 0, sourceFileCount: 999, namingConventions: [],
      }));

      // A partial call shows the cached block; a full one must not re-ingest it.
      await handleProjectOverview({}, tempDir, astIndex());
      const saved = JSON.parse(await readFile(fpPath(), 'utf-8'));

      expect(saved.projectType).not.toContain('OLD');
      expect(saved.sourceFileCount).toBe(293);
      expect(saved.frameworks).not.toContain('Rx (Async)');
    });

    it('a partial overview (include) neither overwrites the cache nor hides it', async () => {
      await handleProjectOverview({}, tempDir, astIndex());
      const before = await readFile(fpPath(), 'utf-8');

      const text = (await handleProjectOverview({ include: ['stack'] }, tempDir, astIndex(5))).content[0].text;

      expect(await readFile(fpPath(), 'utf-8')).toBe(before);
      expect(text).toContain('Cached Architecture');
    });

    it('a full overview does not repeat itself with the cached block', async () => {
      await handleProjectOverview({}, tempDir, astIndex());
      const text = (await handleProjectOverview({}, tempDir, astIndex())).content[0].text;

      expect(text).not.toContain('Cached Architecture');
    });

    it('lists entry files, not directories', async () => {
      await writeFile(join(tempDir, 'package.json'), JSON.stringify({
        name: 'demo-app', version: '1.2.3', main: 'dist/index.js', bin: { demo: 'dist/cli.js' },
      }));
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(join(tempDir, 'src', 'index.ts'), '');
      await writeFile(join(tempDir, 'src', 'cli.ts'), '');

      const text = (await handleProjectOverview({}, tempDir, astIndex())).content[0].text;
      const saved = JSON.parse(await readFile(fpPath(), 'utf-8'));

      expect(text).toContain('ENTRYPOINTS: src/index.ts, src/cli.ts');
      expect(saved.entrypoints).toEqual(['src/index.ts', 'src/cli.ts']);
    });
  });

  it('shows degraded mode guidance when ast-index is disabled', async () => {
    const astIndex = {
      isAvailable: () => false,
      isOversized: () => false,
      isDisabled: () => true,
    } as any;

    const result = await handleProjectOverview({}, tempDir, astIndex);
    expect(result.content[0].text).toContain('project root not detected');
  });
});
