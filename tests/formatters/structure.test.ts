import { describe, it, expect } from 'vitest';
import { formatOutline } from '../../src/formatters/structure.js';
import type { FileStructure, SymbolInfo } from '../../src/types.js';

function makeSymbol(overrides: Partial<SymbolInfo> & { name: string }): SymbolInfo {
  return {
    qualifiedName: overrides.name,
    kind: 'function',
    signature: `function ${overrides.name}()`,
    location: { startLine: 1, endLine: 10, lineCount: 10 },
    visibility: 'public',
    async: false,
    static: false,
    decorators: [],
    children: [],
    doc: null,
    references: [],
    ...overrides,
  };
}

function makeStructure(symbols: SymbolInfo[]): FileStructure {
  return {
    path: '/src/app.ts',
    language: 'TypeScript',
    meta: { lines: 200, bytes: 8192, lastModified: Date.now(), contentHash: 'abc' },
    imports: [
      { source: 'express', specifiers: ['Router'], isDefault: false, isNamespace: false, line: 1 },
    ],
    exports: [
      { name: 'App', kind: 'class', isDefault: true, line: 5 },
    ],
    symbols,
  };
}

/** Factory used in scope tests — 1 import, 2 exports, 3 symbols */
function makeScopeStructure(): FileStructure {
  const method1 = makeSymbol({
    name: 'method1',
    kind: 'method',
    visibility: 'public',
    location: { startLine: 25, endLine: 35, lineCount: 11 },
  });

  const publicFunc = makeSymbol({
    name: 'publicFunc',
    kind: 'function',
    async: true,
    signature: 'publicFunc(x: number, y: string): boolean',
    location: { startLine: 5, endLine: 15, lineCount: 11 },
    references: ['dep.foo'],
  });

  const PublicClass = makeSymbol({
    name: 'PublicClass',
    kind: 'class',
    location: { startLine: 20, endLine: 80, lineCount: 61 },
    children: [method1],
  });

  const internalHelper = makeSymbol({
    name: 'internalHelper',
    kind: 'function',
    location: { startLine: 85, endLine: 95, lineCount: 11 },
  });

  return {
    path: '/src/mymodule.ts',
    language: 'TypeScript',
    meta: { lines: 100, bytes: 4096, lastModified: Date.now(), contentHash: 'def' },
    imports: [
      { source: './dep', specifiers: ['dep'], isDefault: false, isNamespace: false, line: 1 },
    ],
    exports: [
      { name: 'publicFunc', kind: 'function', isDefault: false, line: 5 },
      { name: 'PublicClass', kind: 'class', isDefault: false, line: 20 },
    ],
    symbols: [publicFunc, PublicClass, internalHelper],
  };
}

describe('formatOutline', () => {
  it('includes file header', () => {
    const structure = makeStructure([]);
    const output = formatOutline(structure);

    expect(output).toContain('FILE: /src/app.ts');
    expect(output).toContain('200 lines');
    expect(output).toContain('LANGUAGE: TypeScript');
  });

  it('shows imports when enabled', () => {
    const structure = makeStructure([]);
    const output = formatOutline(structure, { showImports: true });

    expect(output).toContain('IMPORTS:');
    expect(output).toContain('Router');
    expect(output).toContain('express');
  });

  it('hides imports when disabled', () => {
    const structure = makeStructure([]);
    const output = formatOutline(structure, { showImports: false });

    expect(output).not.toContain('IMPORTS:');
  });

  it('shows exports', () => {
    const structure = makeStructure([]);
    const output = formatOutline(structure);

    expect(output).toContain('EXPORTS:');
    expect(output).toContain('App');
    expect(output).toContain('default');
  });

  it('formats function symbols with signatures and line ranges', () => {
    const structure = makeStructure([
      makeSymbol({
        name: 'handleRequest',
        signature: 'async handleRequest(req: Request): Promise<Response>',
        async: true,
        location: { startLine: 10, endLine: 25, lineCount: 16 },
      }),
    ]);

    const output = formatOutline(structure);
    expect(output).toContain('STRUCTURE:');
    expect(output).toContain('async');
    expect(output).toContain('handleRequest');
    expect(output).toContain('[L10-25]');
    expect(output).toContain('16 lines');
  });

  it('formats class with children grouped by visibility', () => {
    const publicMethod = makeSymbol({
      name: 'getUser',
      kind: 'method',
      visibility: 'public',
      location: { startLine: 10, endLine: 20, lineCount: 11 },
    });
    const privateMethod = makeSymbol({
      name: 'validate',
      kind: 'method',
      visibility: 'private',
      location: { startLine: 21, endLine: 30, lineCount: 10 },
    });

    const classSymbol = makeSymbol({
      name: 'UserService',
      kind: 'class',
      children: [publicMethod, privateMethod],
      location: { startLine: 5, endLine: 50, lineCount: 46 },
    });

    const structure = makeStructure([classSymbol]);
    const output = formatOutline(structure, { maxDepth: 3 });

    expect(output).toContain('class UserService');
    expect(output).toContain('Public Methods:');
    expect(output).toContain('Private Methods:');
    expect(output).toContain('getUser');
    expect(output).toContain('validate');
  });

  it('respects maxDepth', () => {
    const deepChild = makeSymbol({ name: 'inner', location: { startLine: 15, endLine: 20, lineCount: 6 } });
    const classSymbol = makeSymbol({
      name: 'Outer',
      kind: 'class',
      children: [deepChild],
      location: { startLine: 1, endLine: 50, lineCount: 50 },
    });

    const structure = makeStructure([classSymbol]);
    const output = formatOutline(structure, { maxDepth: 1 });

    expect(output).toContain('1 members — increase depth to see');
  });

  it('shows dependency hints (references)', () => {
    const sym = makeSymbol({
      name: 'processOrder',
      references: ['validatePayment', 'sendEmail'],
      location: { startLine: 1, endLine: 10, lineCount: 10 },
    });

    const structure = makeStructure([sym]);
    const output = formatOutline(structure, { showDependencyHints: true });

    expect(output).toContain('calls: validatePayment, sendEmail');
  });

  it('shows decorators', () => {
    const sym = makeSymbol({
      name: 'handler',
      decorators: ['Get', 'Auth'],
      location: { startLine: 1, endLine: 10, lineCount: 10 },
    });

    const structure = makeStructure([sym]);
    const output = formatOutline(structure);

    expect(output).toContain('@Get');
    expect(output).toContain('@Auth');
  });

  it('includes HINT at the end', () => {
    const structure = makeStructure([]);
    const output = formatOutline(structure);

    expect(output).toContain('HINT: Use read_symbol');
  });
});

describe('formatOutline scope parameter', () => {
  it('scope=nav: contains symbol names and line ranges', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'nav' });

    expect(output).toContain('publicFunc()');
    expect(output).toContain('[L5-15]');
    expect(output).toContain('PublicClass');
    expect(output).toContain('[L20-80]');
    expect(output).toContain('internalHelper()');
    expect(output).toContain('[L85-95]');
  });

  it('scope=nav: does NOT contain type signatures, IMPORTS section, or calls lines', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'nav' });

    expect(output).not.toContain('x: number');
    expect(output).not.toContain('IMPORTS:');
    expect(output).not.toContain('calls:');
  });

  it('scope=nav: shows SYMBOLS header and scope hint', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'nav' });

    expect(output).toContain('SYMBOLS:');
    expect(output).toContain('scope="full"');
  });

  it('scope=nav: shows nested children (method1 under PublicClass)', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'nav' });

    expect(output).toContain('method1()');
    expect(output).toContain('[L25-35]');
  });

  it('scope=exports: contains exported symbols publicFunc and PublicClass', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'exports' });

    expect(output).toContain('publicFunc');
    expect(output).toContain('PublicClass');
  });

  it('scope=exports: does NOT contain internalHelper', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'exports' });

    expect(output).not.toContain('internalHelper');
  });

  it('scope=exports: contains HINT about hidden non-exported symbols', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'exports' });

    expect(output).toContain('HINT');
  });

  it('scope=full (default): contains IMPORTS, type signatures, internalHelper, calls', () => {
    const structure = makeScopeStructure();
    const output = formatOutline(structure, { scope: 'full' });

    expect(output).toContain('IMPORTS:');
    expect(output).toContain('internalHelper');
    expect(output).toContain('x: number');
    expect(output).toContain('calls:');
  });

  it('scope default (undefined) behaves like full', () => {
    const structure = makeScopeStructure();
    const outputDefault = formatOutline(structure);
    const outputFull = formatOutline(structure, { scope: 'full' });

    expect(outputDefault).toContain('IMPORTS:');
    expect(outputDefault).toContain('internalHelper');
  });
});
