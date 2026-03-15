import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleExploreArea } from '../../src/handlers/explore-area.js';

const execFileAsync = promisify(execFile);

describe('handleExploreArea', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-explore-'));
    await mkdir(join(tempDir, 'src'));
    await mkdir(join(tempDir, 'shared'));
    await mkdir(join(tempDir, 'tests'));
    await writeFile(join(tempDir, 'src', 'feature.ts'), 'export function feature() {}\n');
    await writeFile(join(tempDir, 'shared', 'util.ts'), 'export function util() {}\n');
    await writeFile(join(tempDir, 'tests', 'feature.test.ts'), 'import { feature } from "../src/feature";\n');

    await execFileAsync('git', ['init'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.email', 'tests@example.com'], { cwd: tempDir });
    await execFileAsync('git', ['config', 'user.name', 'Token Pilot Tests'], { cwd: tempDir });
    await execFileAsync('git', ['add', '.'], { cwd: tempDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('collects import, test, and change metadata for an area', async () => {
    const astIndex = {
      isAvailable: () => true,
      isDisabled: () => false,
      isOversized: () => false,
      fileImports: async () => [
        { source: '../shared/util' },
        { source: 'react' },
      ],
      refs: async () => ({
        imports: [{ path: join(tempDir, 'app', 'page.ts') }],
      }),
      outline: async () => ({
        meta: { lines: 1 },
        symbols: [{
          name: 'feature',
          kind: 'function',
          decorators: [],
          async: false,
          children: [],
          location: { startLine: 1, endLine: 1 },
        }],
      }),
    } as any;

    await mkdir(join(tempDir, 'app'));
    await writeFile(join(tempDir, 'app', 'page.ts'), 'import { feature } from "../src/feature";\n');

    const result = await handleExploreArea(
      { path: 'src/feature.ts', include: ['imports', 'tests', 'changes'] },
      tempDir,
      astIndex,
    );

    const text = result.content[0].text;
    expect(text).toContain('AREA: src/');
    expect(text).toContain('IMPORTS: react');
    expect(text).toContain('TESTS: tests/feature.test.ts');
    expect(text).toContain('RECENT CHANGES:');
    expect(result.meta.codeFiles).toEqual(['src/feature.ts']);
    expect(result.meta.internalDeps).toEqual(['shared/util']);
    expect(result.meta.importedBy).toEqual(['app/page']);
    expect(result.meta.testFiles).toEqual(['tests/feature.test.ts']);
    expect(result.meta.changeCount).toBeGreaterThan(0);
  });
});
