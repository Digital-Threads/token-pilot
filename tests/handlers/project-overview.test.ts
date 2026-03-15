import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
