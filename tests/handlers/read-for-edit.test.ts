import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleReadForEdit } from '../../src/handlers/read-for-edit.js';
import { FileCache } from '../../src/core/file-cache.js';
import { ContextRegistry } from '../../src/core/context-registry.js';

describe('handleReadForEdit', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'token-pilot-edit-'));
    filePath = join(tempDir, 'file.ts');
    await writeFile(filePath, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires either symbol or line', async () => {
    const result = await handleReadForEdit(
      { path: 'file.ts' },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );

    expect(result.content[0].text).toContain('Either "symbol" or "line" must be provided');
  });

  it('returns a line-based raw edit context', async () => {
    const result = await handleReadForEdit(
      { path: 'file.ts', line: 10, context: 2 },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );

    expect(result.content[0].text).toContain('TARGET: line 10');
    expect(result.content[0].text).toContain('SHOWING: L8-12');
    expect(result.content[0].text).toContain('For Read requirement: Read("file.ts", offset=8, limit=5)');
  });

  it('limits large symbols and tracks edit context', async () => {
    const registry = new ContextRegistry();
    const result = await handleReadForEdit(
      { path: 'file.ts', symbol: 'BigClass' },
      tempDir,
      {
        resolve: async () => ({
          startLine: 20,
          endLine: 95,
        }),
      } as any,
      new FileCache(),
      registry,
      {
        outline: async () => ({ symbols: [] }),
      } as any,
    );

    expect(result.content[0].text).toContain('showing first 60 of 76 lines');
    expect(result.content[0].text).toContain('SHOWING: L15-84');
    expect(registry.isSymbolLoaded(filePath, 'BigClass')).toBe(true);
  });

  it('reports symbol and line validation errors', async () => {
    const missingSymbol = await handleReadForEdit(
      { path: 'file.ts', symbol: 'Missing' },
      tempDir,
      { resolve: async () => null } as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );
    expect(missingSymbol.content[0].text).toContain('Symbol "Missing" not found');

    const badLine = await handleReadForEdit(
      { path: 'file.ts', line: 999 },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );
    expect(badLine.content[0].text).toContain('Line 999 out of range');
  });

  describe('include_callers', () => {
    it('shows callers when include_callers=true and symbol resolved', async () => {
      const result = await handleReadForEdit(
        { path: 'file.ts', symbol: 'MyFunc', include_callers: true },
        tempDir,
        {
          resolve: async () => ({ startLine: 10, endLine: 15 }),
        } as any,
        new FileCache(),
        new ContextRegistry(),
        {
          outline: async () => null,
          isDisabled: () => false,
          refs: async () => ({
            definitions: [],
            imports: [],
            usages: [
              { name: 'MyFunc', line: 42, path: join(tempDir, 'caller.ts'), context: 'const x = MyFunc()' },
              { name: 'MyFunc', line: 10, path: join(tempDir, 'other.ts'), context: 'MyFunc(arg)' },
            ],
          }),
        } as any,
      );

      expect(result.content[0].text).toContain('CALLERS (2):');
      expect(result.content[0].text).toContain('caller.ts:42');
      expect(result.content[0].text).toContain('MyFunc()');
    });

    it('shows "none found" when no callers exist', async () => {
      const result = await handleReadForEdit(
        { path: 'file.ts', symbol: 'Unused', include_callers: true },
        tempDir,
        {
          resolve: async () => ({ startLine: 10, endLine: 15 }),
        } as any,
        new FileCache(),
        new ContextRegistry(),
        {
          outline: async () => null,
          isDisabled: () => false,
          refs: async () => ({ definitions: [], imports: [], usages: [] }),
        } as any,
      );

      expect(result.content[0].text).toContain('CALLERS: none found');
    });
  });

  describe('include_tests', () => {
    it('shows test file path when test file exists', async () => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(tempDir, 'src', 'core'), { recursive: true });
      mkdirSync(join(tempDir, 'tests', 'core'), { recursive: true });
      writeFileSync(join(tempDir, 'src', 'core', 'utils.ts'), 'export function helper() {}');
      writeFileSync(join(tempDir, 'tests', 'core', 'utils.test.ts'), 'describe("helper", () => {})');

      const result = await handleReadForEdit(
        { path: 'src/core/utils.ts', line: 1, include_tests: true },
        tempDir,
        {} as any,
        new FileCache(),
        new ContextRegistry(),
        { outline: async () => null, isDisabled: () => true } as any,
      );

      expect(result.content[0].text).toContain('TESTS: tests/core/utils.test.ts');
    });

    it('shows fallback when no test file exists', async () => {
      const result = await handleReadForEdit(
        { path: 'file.ts', line: 10, include_tests: true },
        tempDir,
        {} as any,
        new FileCache(),
        new ContextRegistry(),
        { outline: async () => null, isDisabled: () => true } as any,
      );

      expect(result.content[0].text).toContain('TESTS: none found');
    });
  });

  describe('include_changes', () => {
    it('shows "none" when file is unchanged in git', async () => {
      const { execSync } = await import('node:child_process');
      execSync('git init && git add -A && git commit -m "init"', {
        cwd: tempDir,
        stdio: 'ignore',
      });

      const result = await handleReadForEdit(
        { path: 'file.ts', line: 10, include_changes: true },
        tempDir,
        {} as any,
        new FileCache(),
        new ContextRegistry(),
        { outline: async () => null } as any,
      );

      expect(result.content[0].text).toMatch(/RECENT CHANGES: none/);
    });

    it('shows diff when file has unstaged changes', async () => {
      const { execSync } = await import('node:child_process');
      execSync('git init && git add -A && git commit -m "init"', {
        cwd: tempDir,
        stdio: 'ignore',
      });

      const fileContent = Array.from({ length: 100 }, (_, i) =>
        i === 9 ? 'MODIFIED line 10' : `line ${i + 1}`,
      ).join('\n');
      await writeFile(join(tempDir, 'file.ts'), fileContent);

      const result = await handleReadForEdit(
        { path: 'file.ts', line: 10, context: 2, include_changes: true },
        tempDir,
        {} as any,
        new FileCache(),
        new ContextRegistry(),
        { outline: async () => null } as any,
      );

      expect(result.content[0].text).toContain('RECENT CHANGES (unstaged):');
      expect(result.content[0].text).toContain('-line 10');
      expect(result.content[0].text).toContain('+MODIFIED line 10');
    });
  });

  it('returns normal output without enrichment when no include flags', async () => {
    const result = await handleReadForEdit(
      { path: 'file.ts', line: 10, context: 2 },
      tempDir,
      {} as any,
      new FileCache(),
      new ContextRegistry(),
      { outline: async () => null } as any,
    );

    expect(result.content[0].text).toContain('EDIT CONTEXT');
    expect(result.content[0].text).not.toContain('CALLERS');
    expect(result.content[0].text).not.toContain('TESTS:');
    expect(result.content[0].text).not.toContain('RECENT CHANGES');
  });
});
