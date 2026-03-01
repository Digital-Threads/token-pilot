import { describe, it, expect } from 'vitest';
import { handleExportAstIndex } from '../../src/handlers/export-ast-index.js';
import { FileCache } from '../../src/core/file-cache.js';
import { AstIndexClient } from '../../src/ast-index/client.js';
import type { CacheEntry } from '../../src/types.js';

function makeCacheEntry(path: string, language: string): CacheEntry {
  return {
    structure: {
      path,
      language,
      meta: { lines: 100, bytes: 2048, lastModified: Date.now(), contentHash: 'abc' },
      imports: [{ source: './utils', specifiers: ['helper'], isDefault: false, isNamespace: false, line: 1 }],
      exports: [{ name: 'MyClass', kind: 'class', isDefault: true, line: 5 }],
      symbols: [
        {
          name: 'MyClass',
          qualifiedName: 'MyClass',
          kind: 'class',
          signature: 'class MyClass',
          location: { startLine: 5, endLine: 50, lineCount: 45 },
          visibility: 'public',
          async: false,
          static: false,
          decorators: [],
          children: [
            {
              name: 'doWork',
              qualifiedName: 'MyClass.doWork',
              kind: 'method',
              signature: 'async doWork(input: string): Promise<void>',
              location: { startLine: 10, endLine: 30, lineCount: 20 },
              visibility: 'public',
              async: true,
              static: false,
              decorators: [],
              children: [],
              doc: 'Performs work.',
              references: [],
            },
          ],
          doc: 'Main class.',
          references: [],
        },
      ],
    },
    content: 'class MyClass {}',
    lines: ['class MyClass {}'],
    mtime: Date.now(),
    hash: 'abc123',
    lastAccess: Date.now(),
  };
}

describe('handleExportAstIndex', () => {
  const astIndex = new AstIndexClient('/tmp', 5000);

  it('returns empty message when no files cached', async () => {
    const cache = new FileCache(100, 80);
    const result = await handleExportAstIndex({}, astIndex, cache);
    expect(result.content[0].text).toContain('No cached files');
  });

  it('exports markdown by default', async () => {
    const cache = new FileCache(100, 80);
    cache.set('/tmp/app.ts', makeCacheEntry('app.ts', 'typescript'));

    const result = await handleExportAstIndex({}, astIndex, cache);
    const text = result.content[0].text;

    expect(text).toContain('# Token Pilot AST Index Export');
    expect(text).toContain('## app.ts');
    expect(text).toContain('### Imports');
    expect(text).toContain('`helper`');
    expect(text).toContain('class `MyClass`');
    expect(text).toContain('method `doWork`');
    expect(text).toContain('index');
  });

  it('exports json when format=json', async () => {
    const cache = new FileCache(100, 80);
    cache.set('/tmp/app.ts', makeCacheEntry('app.ts', 'typescript'));

    const result = await handleExportAstIndex({ format: 'json' }, astIndex, cache);
    const data = JSON.parse(result.content[0].text);

    expect(data).toHaveLength(1);
    expect(data[0].path).toBe('app.ts');
    expect(data[0].symbols).toHaveLength(2); // MyClass + doWork (flattened)
    expect(data[0].symbols[0].name).toBe('MyClass');
    expect(data[0].symbols[1].name).toBe('doWork');
  });

  it('filters by paths when specified', async () => {
    const cache = new FileCache(100, 80);
    cache.set('/tmp/a.ts', makeCacheEntry('a.ts', 'typescript'));
    cache.set('/tmp/b.ts', makeCacheEntry('b.ts', 'typescript'));

    const result = await handleExportAstIndex({ paths: ['/tmp/a.ts'] }, astIndex, cache);
    const text = result.content[0].text;

    expect(text).toContain('## a.ts');
    expect(text).not.toContain('## b.ts');
  });

  it('ignores paths not in cache', async () => {
    const cache = new FileCache(100, 80);
    cache.set('/tmp/a.ts', makeCacheEntry('a.ts', 'typescript'));

    const result = await handleExportAstIndex({ paths: ['/tmp/nonexistent.ts'] }, astIndex, cache);
    expect(result.content[0].text).toContain('No cached files');
  });
});
