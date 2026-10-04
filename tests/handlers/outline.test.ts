import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleOutline } from '../../src/handlers/outline.js';

describe('handleOutline', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-outline-'));
    await mkdir(join(tempDir, 'src'));
    await mkdir(join(tempDir, 'src', 'nested'));
    await writeFile(join(tempDir, 'src', 'a.ts'), 'export function alpha() {}\n');
    await writeFile(join(tempDir, 'src', 'nested', 'b.ts'), 'export function beta() {}\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('leaves out node_modules, dist, coverage and .git — and says so', async () => {
    for (const dir of ['node_modules/x', 'dist', 'coverage', '.git/hooks', 'src/node_modules/y']) {
      await mkdir(join(tempDir, dir), { recursive: true });
      await writeFile(join(tempDir, dir, 'f.js'), 'module.exports = 1;\n');
    }
    const astIndex = { outline: async () => null } as any;

    const text = (await handleOutline({ path: '.' }, tempDir, astIndex)).content[0].text;

    // src/node_modules/y/f.js is not counted either
    expect(text).toContain('src/ (2 code files)');
    for (const dir of ['node_modules/', 'dist/', 'coverage/', '.git/']) {
      expect(text).not.toContain(`  ${dir} (`);
    }
    expect(text).toMatch(/not shown: .*node_modules/);
    expect(text).toMatch(/OUTLINE: \.\/ \(1 subdirs\)/);
  });

  it('returns a guidance message when path is not a directory', async () => {
    const result = await handleOutline({ path: 'src/a.ts' }, tempDir, {} as any);
    expect(result.content[0].text).toContain('is not a directory');
  });

  it('recursively outlines nested directories and files', async () => {
    const astIndex = {
      outline: async (filePath: string) => ({
        meta: { lines: 1 },
        symbols: [{
          name: filePath.endsWith('a.ts') ? 'alpha' : 'beta',
          kind: 'function',
          decorators: [],
          async: false,
          children: [],
          location: { startLine: 1, endLine: 1 },
        }],
      }),
    } as any;

    const result = await handleOutline(
      { path: 'src', recursive: true, max_depth: 2 },
      tempDir,
      astIndex,
    );

    const text = result.content[0].text;
    expect(text).toContain('OUTLINE: src/');
    expect(text).toContain('OUTLINE: src/nested/');
    expect(text).toContain('a.ts (1 lines)');
    expect(text).toContain('beta [L1-1]');
  });
});
