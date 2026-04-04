import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSmartReadMany } from '../../src/handlers/smart-read-many.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('handleSmartReadMany', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-many-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('skips duplicate paths and reports that in the batch summary', async () => {
    await writeFile(join(tempDir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(tempDir, 'b.ts'), 'export const b = 2;\n');

    const result = await handleSmartReadMany(
      { paths: ['a.ts', 'a.ts', 'b.ts'] },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      DEFAULT_CONFIG,
    );

    const text = result.content[0].text;
    expect(text).toContain('BATCH: 2 unique files loaded (1 duplicates skipped)');
  });

  it('returns compact reminder on second call for unchanged file', async () => {
    const smallContent = Array.from({ length: 10 }, (_, i) =>
      `export const val${i} = ${i};`,
    ).join('\n');

    await writeFile(join(tempDir, 'small.ts'), smallContent);

    const fileCache = new FileCache();
    const contextRegistry = new ContextRegistry();

    const firstResult = await handleSmartReadMany(
      { paths: ['small.ts'] },
      tempDir,
      {} as any,
      fileCache,
      contextRegistry,
      DEFAULT_CONFIG,
    );

    const secondResult = await handleSmartReadMany(
      { paths: ['small.ts'] },
      tempDir,
      {} as any,
      fileCache,
      contextRegistry,
      DEFAULT_CONFIG,
    );

    const firstText = firstResult.content[0].text;
    const secondText = secondResult.content[0].text;

    expect(firstText).not.toContain('REMINDER:');
    expect(secondText).toContain('REMINDER:');
    expect(secondText).toContain('unchanged');
  });

  it('compacts oversized batch output and keeps a per-file follow-up hint', async () => {
    const largeContent = Array.from({ length: 180 }, (_, i) =>
      `export const value${i} = "${'x'.repeat(40)}";`,
    ).join('\n');

    await writeFile(join(tempDir, 'big-a.ts'), largeContent);
    await writeFile(join(tempDir, 'big-b.ts'), largeContent);
    await writeFile(join(tempDir, 'big-c.ts'), largeContent);

    const result = await handleSmartReadMany(
      { paths: ['big-a.ts', 'big-b.ts', 'big-c.ts'] },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      DEFAULT_CONFIG,
    );

    const text = result.content[0].text;
    expect(text).toContain('compacted for batch mode');
    expect(text).toContain('Use smart_read("big-c.ts") for full detail.');
    expect(text).toContain('TOKEN SAVINGS:');
  });
});
