import { describe, it, expect, vi } from 'vitest';
import { SymbolResolver } from '../../src/core/symbol-resolver.js';
import type { AstIndexClient } from '../../src/ast-index/client.js';
import type { FileStructure, SymbolInfo } from '../../src/types.js';

function makeSymbol(name: string, start: number, end: number, children: SymbolInfo[] = []): SymbolInfo {
  return {
    name,
    qualifiedName: name,
    kind: 'function',
    signature: `function ${name}()`,
    location: { startLine: start, endLine: end, lineCount: end - start + 1 },
    visibility: 'public',
    async: false,
    static: false,
    decorators: [],
    children,
    doc: null,
    references: [],
  };
}

function makeStructure(symbols: SymbolInfo[]): FileStructure {
  return {
    path: '/test.ts',
    language: 'TypeScript',
    meta: { lines: 100, bytes: 500, lastModified: Date.now(), contentHash: 'abc' },
    imports: [],
    exports: [],
    symbols,
  };
}

describe('SymbolResolver', () => {
  it('resolves via ast-index when available', async () => {
    const mockClient = {
      symbol: vi.fn().mockResolvedValue({
        name: 'myFunc',
        qualified_name: 'myFunc',
        kind: 'function',
        file: '/test.ts',
        start_line: 5,
        end_line: 15,
        signature: 'function myFunc()',
        references: ['otherFunc'],
      }),
    } as unknown as AstIndexClient;

    const resolver = new SymbolResolver(mockClient);
    const result = await resolver.resolve('myFunc');

    expect(result).not.toBeNull();
    expect(result!.symbol.name).toBe('myFunc');
    expect(result!.startLine).toBe(5);
    expect(result!.endLine).toBe(15);
    expect(result!.symbol.references).toContain('otherFunc');
  });

  it('falls back to structure search when ast-index returns null', async () => {
    const mockClient = {
      symbol: vi.fn().mockResolvedValue(null),
    } as unknown as AstIndexClient;

    const structure = makeStructure([
      makeSymbol('foo', 1, 10),
      makeSymbol('bar', 11, 20),
    ]);

    const resolver = new SymbolResolver(mockClient);
    const result = await resolver.resolve('bar', structure);

    expect(result).not.toBeNull();
    expect(result!.symbol.name).toBe('bar');
    expect(result!.startLine).toBe(11);
  });

  it('resolves Class.method via dot notation', async () => {
    const mockClient = {
      symbol: vi.fn().mockResolvedValue(null),
    } as unknown as AstIndexClient;

    const childMethod = makeSymbol('doWork', 5, 15);
    const parentClass = makeSymbol('MyClass', 1, 50, [childMethod]);
    parentClass.kind = 'class';
    const structure = makeStructure([parentClass]);

    const resolver = new SymbolResolver(mockClient);
    const result = await resolver.resolve('MyClass.doWork', structure);

    expect(result).not.toBeNull();
    expect(result!.symbol.name).toBe('doWork');
  });

  it('returns null when symbol not found', async () => {
    const mockClient = {
      symbol: vi.fn().mockResolvedValue(null),
    } as unknown as AstIndexClient;

    const structure = makeStructure([makeSymbol('foo', 1, 10)]);
    const resolver = new SymbolResolver(mockClient);
    const result = await resolver.resolve('nonexistent', structure);

    expect(result).toBeNull();
  });

  it('extracts source with line numbers', async () => {
    const mockClient = {
      symbol: vi.fn().mockResolvedValue(null),
    } as unknown as AstIndexClient;

    const resolver = new SymbolResolver(mockClient);
    const lines = [
      'line 1',
      'line 2',
      'function foo() {',
      '  return 42;',
      '}',
      'line 6',
    ];

    const resolved = {
      symbol: makeSymbol('foo', 3, 5),
      filePath: '/test.ts',
      startLine: 3,
      endLine: 5,
    };

    const source = resolver.extractSource(resolved, lines, { contextBefore: 1, contextAfter: 1 });
    expect(source).toContain('line 2');
    expect(source).toContain('function foo()');
    expect(source).toContain('return 42');
    expect(source).toContain('}');
    expect(source).toContain('line 6');
  });

  it('extractSource clamps to file boundaries', async () => {
    const mockClient = {
      symbol: vi.fn().mockResolvedValue(null),
    } as unknown as AstIndexClient;

    const resolver = new SymbolResolver(mockClient);
    const lines = ['line 1', 'line 2', 'line 3'];

    const resolved = {
      symbol: makeSymbol('foo', 1, 3),
      filePath: '/test.ts',
      startLine: 1,
      endLine: 3,
    };

    // contextBefore=5 should clamp to line 0
    const source = resolver.extractSource(resolved, lines, { contextBefore: 5, contextAfter: 5 });
    expect(source.split('\n')).toHaveLength(3);
  });
});
