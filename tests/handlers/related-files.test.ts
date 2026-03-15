import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleRelatedFiles } from '../../src/handlers/related-files.js';

describe('handleRelatedFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-related-'));
    await mkdir(join(tempDir, 'src'));
    await mkdir(join(tempDir, 'tests'));
    await writeFile(join(tempDir, 'src', 'a.ts'), 'export function a() { return b(); }\n');
    await writeFile(join(tempDir, 'src', 'b.ts'), 'export function b() { return 1; }\n');
    await writeFile(join(tempDir, 'tests', 'a.test.ts'), 'import { a } from "../src/a";\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns related file sections and structured meta', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      fileImports: async () => [{ source: './b', specifiers: ['b'] }],
      outline: async () => ({ symbols: [{ name: 'a' }] }),
      refs: async () => ({
        imports: [{ path: join(tempDir, 'src', 'consumer.ts') }],
        usages: [],
      }),
      listFiles: async () => [join(tempDir, 'tests', 'a.test.ts')],
    } as any;

    await writeFile(join(tempDir, 'src', 'consumer.ts'), 'import { a } from "./a";\n');

    const result = await handleRelatedFiles({ path: 'src/a.ts' }, tempDir, astIndex);
    const text = result.content[0].text;

    expect(text).toContain('IMPORTS (this file uses):');
    expect(text).toContain('IMPORTED BY (uses this file):');
    expect(text).toContain('TESTS:');
    expect(result.meta.imports).toEqual(['src/b.ts']);
    expect(result.meta.importedBy).toEqual(['src/consumer.ts']);
    expect(result.meta.tests).toEqual(['tests/a.test.ts']);
  });
});
