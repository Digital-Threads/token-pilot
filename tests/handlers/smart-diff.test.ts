import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, mapHunksToSymbols } from '../../src/handlers/smart-diff.js';
import { validateSmartDiffArgs, validateExploreAreaArgs } from '../../src/core/validation.js';
import type { FileStructure } from '../../src/types.js';

describe('parseUnifiedDiff', () => {
  it('parses a single-file diff with one hunk', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc1234..def5678 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,3 +10,4 @@ function bar() {',
      '   const a = 1;',
      '+  const b = 2;',
      '   return a;',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[0].addedLines).toBe(1);
    expect(files[0].removedLines).toBe(0);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0].newStart).toBe(10);
    expect(files[0].hunks[0].newCount).toBe(4);
    expect(files[0].isNew).toBe(false);
    expect(files[0].isDeleted).toBe(false);
    expect(files[0].isBinary).toBe(false);
  });

  it('parses multiple files', () => {
    const raw = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+added',
      ' line2',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,3 +5,2 @@',
      ' keep',
      '-removed',
      ' keep2',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('a.ts');
    expect(files[0].addedLines).toBe(1);
    expect(files[1].path).toBe('b.ts');
    expect(files[1].removedLines).toBe(1);
  });

  it('detects new files', () => {
    const raw = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+line1',
      '+line2',
      '+line3',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].isNew).toBe(true);
    expect(files[0].addedLines).toBe(3);
  });

  it('detects deleted files', () => {
    const raw = [
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].isDeleted).toBe(true);
    expect(files[0].removedLines).toBe(2);
  });

  it('detects binary files', () => {
    const raw = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].isBinary).toBe(true);
  });

  it('detects renamed files', () => {
    const raw = [
      'diff --git a/old-name.ts b/new-name.ts',
      'rename from old-name.ts',
      'rename to new-name.ts',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new-name.ts');
    expect(files[0].oldPath).toBe('old-name.ts');
  });

  it('handles multiple hunks in one file', () => {
    const raw = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,4 @@',
      ' a',
      '+b',
      ' c',
      ' d',
      '@@ -20,3 +21,4 @@',
      ' x',
      '+y',
      ' z',
      ' w',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0].newStart).toBe(1);
    expect(files[0].hunks[1].newStart).toBe(21);
    expect(files[0].addedLines).toBe(2);
  });

  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   ')).toEqual([]);
  });

  it('handles hunk with no count (single line)', () => {
    const raw = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    expect(files[0].hunks[0].newStart).toBe(5);
    expect(files[0].hunks[0].newCount).toBe(1);
  });
});

describe('mapHunksToSymbols', () => {
  const makeStructure = (symbols: FileStructure['symbols']): FileStructure => ({
    meta: { lines: 100, hasDefaultExport: false, size: 1000, ext: 'ts' },
    imports: [],
    symbols,
  });

  it('maps a hunk to overlapping symbol', () => {
    const structure = makeStructure([
      {
        name: 'doStuff',
        kind: 'function',
        location: { startLine: 10, endLine: 20 },
        children: [],
        decorators: [],
      },
    ]);

    const hunks = [{ newStart: 15, newCount: 3, lines: ['+a', '+b', '+c'] }];
    const result = mapHunksToSymbols(hunks, structure);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('doStuff');
    expect(result[0].changeType).toBe('MODIFIED');
    expect(result[0].lineRange).toBe('[L10-20]');
  });

  it('returns empty for hunk outside all symbols', () => {
    const structure = makeStructure([
      {
        name: 'foo',
        kind: 'function',
        location: { startLine: 10, endLine: 20 },
        children: [],
        decorators: [],
      },
    ]);

    const hunks = [{ newStart: 50, newCount: 3, lines: ['+a'] }];
    const result = mapHunksToSymbols(hunks, structure);
    expect(result).toHaveLength(0);
  });

  it('maps to multiple symbols when hunk spans them', () => {
    const structure = makeStructure([
      {
        name: 'foo',
        kind: 'function',
        location: { startLine: 10, endLine: 20 },
        children: [],
        decorators: [],
      },
      {
        name: 'bar',
        kind: 'function',
        location: { startLine: 22, endLine: 30 },
        children: [],
        decorators: [],
      },
    ]);

    const hunks = [{ newStart: 18, newCount: 10, lines: ['+a'] }];
    const result = mapHunksToSymbols(hunks, structure);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.name).sort()).toEqual(['bar', 'foo']);
  });

  it('flattens class children for symbol matching', () => {
    const structure = makeStructure([
      {
        name: 'MyClass',
        kind: 'class',
        location: { startLine: 1, endLine: 50 },
        decorators: [],
        children: [
          {
            name: 'myMethod',
            kind: 'method',
            location: { startLine: 10, endLine: 20 },
            children: [],
            decorators: [],
          },
        ],
      },
    ]);

    const hunks = [{ newStart: 12, newCount: 3, lines: ['+a'] }];
    const result = mapHunksToSymbols(hunks, structure);
    // Should match both the class and the method
    expect(result.length).toBeGreaterThanOrEqual(1);
    const names = result.map(s => s.name);
    expect(names).toContain('MyClass.myMethod');
  });

  it('deduplicates symbols across multiple hunks', () => {
    const structure = makeStructure([
      {
        name: 'foo',
        kind: 'function',
        location: { startLine: 10, endLine: 30 },
        children: [],
        decorators: [],
      },
    ]);

    const hunks = [
      { newStart: 12, newCount: 2, lines: ['+a'] },
      { newStart: 25, newCount: 2, lines: ['+b'] },
    ];
    const result = mapHunksToSymbols(hunks, structure);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('foo');
  });
});

describe('validateSmartDiffArgs', () => {

  it('defaults to unstaged scope', () => {
    const result = validateSmartDiffArgs({});
    expect(result.scope).toBe('unstaged');
  });

  it('accepts all valid scopes', () => {
    for (const scope of ['unstaged', 'staged']) {
      const result = validateSmartDiffArgs({ scope });
      expect(result.scope).toBe(scope);
    }
  });

  it('requires ref for commit scope', () => {
    expect(() => validateSmartDiffArgs({ scope: 'commit' })).toThrow('ref');
  });

  it('requires ref for branch scope', () => {
    expect(() => validateSmartDiffArgs({ scope: 'branch' })).toThrow('ref');
  });

  it('accepts commit with ref', () => {
    const result = validateSmartDiffArgs({ scope: 'commit', ref: 'abc123' });
    expect(result.ref).toBe('abc123');
  });

  it('throws on invalid scope', () => {
    expect(() => validateSmartDiffArgs({ scope: 'invalid' })).toThrow('scope');
  });
});

describe('validateExploreAreaArgs', () => {

  it('accepts path only', () => {
    const result = validateExploreAreaArgs({ path: 'src/' });
    expect(result.path).toBe('src/');
    expect(result.include).toBeUndefined();
  });

  it('accepts valid include sections', () => {
    const result = validateExploreAreaArgs({ path: 'src/', include: ['outline', 'tests'] });
    expect(result.include).toEqual(['outline', 'tests']);
  });

  it('throws on missing path', () => {
    expect(() => validateExploreAreaArgs({})).toThrow('path');
  });

  it('throws on invalid include section', () => {
    expect(() => validateExploreAreaArgs({ path: 'src/', include: ['invalid'] })).toThrow('include');
  });

  it('throws on non-array include', () => {
    expect(() => validateExploreAreaArgs({ path: 'src/', include: 'outline' })).toThrow('array');
  });

  it('throws on null args', () => {
    expect(() => validateExploreAreaArgs(null)).toThrow('object');
  });
});
