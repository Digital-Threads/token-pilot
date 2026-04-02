import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSmartRead } from '../../src/handlers/smart-read.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('handleSmartRead', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-smart-read-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a directory hint when a directory path is provided', async () => {
    const result = await handleSmartRead(
      { path: '.' },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      DEFAULT_CONFIG,
    );

    expect(result.content[0].text).toContain('is a directory');
    expect(result.content[0].text).toContain('outline(".")');
  });

  it('falls back to a preview when AST support is unavailable for a large file', async () => {
    const content = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(tempDir, 'large.custom'), content);

    const result = await handleSmartRead(
      { path: 'large.custom' },
      tempDir,
      { outline: async () => null } as any,
      new FileCache(),
      new ContextRegistry(),
      {
        ...DEFAULT_CONFIG,
        smartRead: { ...DEFAULT_CONFIG.smartRead, smallFileThreshold: 10 },
      },
    );

    expect(result.content[0].text).toContain('no AST support, preview');
    expect(result.content[0].text).toContain('truncated');
    expect(result.content[0].text).toContain('Use read_range() for full content');
  });

  it('returns a delta response when a file has changed since last read', async () => {
    // Build a file with enough lines (>10 threshold) and TS functions for regex parser
    const makeContent = (fns: string[]) => {
      const lines = fns.map(n => [
        `export function ${n}(x: number): number {`,
        `  // implementation of ${n}`,
        `  return x + 1;`,
        `}`,
        ``,
      ].join('\n'));
      return lines.join('\n');
    };

    const initialFunctions = ['alpha', 'beta', 'gamma'];
    const updatedFunctions = ['alpha', 'beta', 'delta']; // gamma removed, delta added

    const filePath = join(tempDir, 'delta-test.ts');
    await writeFile(filePath, makeContent(initialFunctions));

    const fileCache = new FileCache();
    const registry = new ContextRegistry();
    const config = {
      ...DEFAULT_CONFIG,
      smartRead: {
        ...DEFAULT_CONFIG.smartRead,
        smallFileThreshold: 10, // file will have ~15+ lines, above threshold
        advisoryReminders: true,
        autoDelta: { enabled: true, maxAgeSec: 120 },
      },
    };

    // astIndex returns null so the regex fallback is used
    const astIndex = { outline: async () => null } as any;

    // First read: loads structure into context
    await handleSmartRead({ path: 'delta-test.ts' }, tempDir, astIndex, fileCache, registry, config);

    // Modify the file
    await writeFile(filePath, makeContent(updatedFunctions));

    // Invalidate the file cache so fresh parse happens
    fileCache.invalidate(filePath);

    // Second read: file changed → should produce DELTA response
    const second = await handleSmartRead({ path: 'delta-test.ts' }, tempDir, astIndex, fileCache, registry, config);

    expect(second.content[0].text).toContain('DELTA');
  });

  it('serves a compact reminder on repeated reads of unchanged files', async () => {
    const content = Array.from({ length: 30 }, (_, i) => `export function thing${i}() { return ${i}; }`).join('\n');
    await writeFile(join(tempDir, 'big.ts'), content);

    const astIndex = {
      outline: async (absPath: string) => ({
        path: absPath,
        language: 'TypeScript',
        meta: { lines: 30, bytes: content.length, lastModified: Date.now(), contentHash: 'hash' },
        imports: [],
        exports: [],
        symbols: [
          {
            name: 'thing0',
            qualifiedName: 'thing0',
            kind: 'function',
            signature: 'export function thing0()',
            location: { startLine: 1, endLine: 1, lineCount: 1 },
            visibility: 'public',
            async: false,
            static: false,
            decorators: [],
            children: [],
            doc: null,
            references: [],
          },
        ],
      }),
    } as any;

    const fileCache = new FileCache();
    const registry = new ContextRegistry();
    const config = {
      ...DEFAULT_CONFIG,
      smartRead: { ...DEFAULT_CONFIG.smartRead, smallFileThreshold: 10, advisoryReminders: true },
    };

    const first = await handleSmartRead({ path: 'big.ts' }, tempDir, astIndex, fileCache, registry, config);
    const second = await handleSmartRead({ path: 'big.ts' }, tempDir, astIndex, fileCache, registry, config);

    expect(first.content[0].text).toContain('TOKEN SAVINGS');
    expect(second.content[0].text).toContain('REMINDER:');
    expect(second.content[0].text).toContain('File unchanged since last read');
  });
});
