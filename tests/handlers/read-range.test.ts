import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadRange } from '../../src/handlers/read-range.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadRange', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-range-'));
    await writeFile(join(tempDir, 'file.ts'), 'a\nb\nc\nd\n');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns formatted numbered lines and tracks the range', async () => {
    const registry = new ContextRegistry();
    const result = await handleReadRange(
      { path: 'file.ts', start_line: 2, end_line: 3 },
      tempDir,
      new FileCache(),
      registry,
    );

    expect(result.content[0].text).toContain('FILE: file.ts [L2-3]');
    expect(result.content[0].text).toContain('   2 | b');
    expect(result.content[0].text).toContain('   3 | c');
    expect(registry.getLoaded(join(tempDir, 'file.ts'))?.[0]?.type).toBe('range');
  });

  it('returns an invalid range message when outside file bounds', async () => {
    const result = await handleReadRange(
      { path: 'file.ts', start_line: 10, end_line: 12 },
      tempDir,
      new FileCache(),
      new ContextRegistry(),
    );

    expect(result.content[0].text).toContain('Invalid line range: 10-12');
  });
});
