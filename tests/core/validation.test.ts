import { describe, it, expect } from 'vitest';
import {
  resolveSafePath,
  validateSmartReadArgs,
  validateReadSymbolArgs,
  validateReadRangeArgs,
  validateReadDiffArgs,
  validateSearchCodeArgs,
  validateFindUsagesArgs,
  validateFindImplementationsArgs,
  validateClassHierarchyArgs,
  validateSmartReadManyArgs,
} from '../../src/core/validation.js';

describe('resolveSafePath', () => {
  it('resolves relative paths within root', () => {
    const result = resolveSafePath('/project', 'src/foo.ts');
    expect(result).toBe('/project/src/foo.ts');
  });

  it('resolves absolute paths within root', () => {
    const result = resolveSafePath('/project', '/project/src/foo.ts');
    expect(result).toBe('/project/src/foo.ts');
  });

  it('throws on path traversal', () => {
    expect(() => resolveSafePath('/project', '../../etc/passwd')).toThrow('outside project root');
  });

  it('throws on absolute path outside root', () => {
    expect(() => resolveSafePath('/project', '/etc/passwd')).toThrow('outside project root');
  });
});

describe('validateSmartReadArgs', () => {
  it('accepts valid args', () => {
    const result = validateSmartReadArgs({ path: 'foo.ts' });
    expect(result.path).toBe('foo.ts');
  });

  it('accepts optional booleans', () => {
    const result = validateSmartReadArgs({ path: 'f.ts', show_imports: false, depth: 3 });
    expect(result.show_imports).toBe(false);
    expect(result.depth).toBe(3);
  });

  it('throws on missing path', () => {
    expect(() => validateSmartReadArgs({})).toThrow('path');
  });

  it('throws on null args', () => {
    expect(() => validateSmartReadArgs(null)).toThrow('object');
  });

  it('throws on wrong type for depth', () => {
    expect(() => validateSmartReadArgs({ path: 'f.ts', depth: 'two' })).toThrow('number');
  });
});

describe('validateReadSymbolArgs', () => {
  it('accepts valid args', () => {
    const result = validateReadSymbolArgs({ path: 'f.ts', symbol: 'Foo.bar' });
    expect(result.symbol).toBe('Foo.bar');
  });

  it('throws on missing symbol', () => {
    expect(() => validateReadSymbolArgs({ path: 'f.ts' })).toThrow('symbol');
  });
});

describe('validateReadRangeArgs', () => {
  it('accepts valid args', () => {
    const result = validateReadRangeArgs({ path: 'f.ts', start_line: 1, end_line: 10 });
    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(10);
  });

  it('throws on end < start', () => {
    expect(() => validateReadRangeArgs({ path: 'f.ts', start_line: 10, end_line: 5 })).toThrow('>=');
  });

  it('throws on non-integer', () => {
    expect(() => validateReadRangeArgs({ path: 'f.ts', start_line: 1.5, end_line: 10 })).toThrow('positive integer');
  });

  it('throws on zero', () => {
    expect(() => validateReadRangeArgs({ path: 'f.ts', start_line: 0, end_line: 10 })).toThrow('positive integer');
  });
});

describe('validateReadDiffArgs', () => {
  it('accepts valid args', () => {
    const result = validateReadDiffArgs({ path: 'f.ts' });
    expect(result.path).toBe('f.ts');
    expect(result.context_lines).toBeUndefined();
  });

  it('accepts optional context_lines', () => {
    const result = validateReadDiffArgs({ path: 'f.ts', context_lines: 5 });
    expect(result.context_lines).toBe(5);
  });
});

describe('validateSearchCodeArgs', () => {
  it('accepts valid args', () => {
    const result = validateSearchCodeArgs({ query: 'handleRequest' });
    expect(result.query).toBe('handleRequest');
  });

  it('accepts optional params', () => {
    const result = validateSearchCodeArgs({ query: 'foo', in_file: 'bar.ts', max_results: 5, fuzzy: true });
    expect(result.in_file).toBe('bar.ts');
    expect(result.max_results).toBe(5);
    expect(result.fuzzy).toBe(true);
  });

  it('throws on empty query', () => {
    expect(() => validateSearchCodeArgs({ query: '' })).toThrow('non-empty');
  });
});

describe('validateFindUsagesArgs', () => {
  it('accepts valid args', () => {
    expect(validateFindUsagesArgs({ symbol: 'MyClass' }).symbol).toBe('MyClass');
  });

  it('throws on missing symbol', () => {
    expect(() => validateFindUsagesArgs({})).toThrow('symbol');
  });
});

describe('validateFindImplementationsArgs', () => {
  it('accepts valid args', () => {
    expect(validateFindImplementationsArgs({ name: 'IService' }).name).toBe('IService');
  });

  it('throws on missing name', () => {
    expect(() => validateFindImplementationsArgs({})).toThrow('name');
  });
});

describe('validateClassHierarchyArgs', () => {
  it('accepts valid args', () => {
    expect(validateClassHierarchyArgs({ name: 'BaseClass' }).name).toBe('BaseClass');
  });
});

describe('validateSmartReadManyArgs', () => {
  it('accepts valid args', () => {
    const result = validateSmartReadManyArgs({ paths: ['a.ts', 'b.ts'] });
    expect(result.paths).toHaveLength(2);
  });

  it('throws on non-array', () => {
    expect(() => validateSmartReadManyArgs({ paths: 'a.ts' })).toThrow('array');
  });

  it('throws on empty string in array', () => {
    expect(() => validateSmartReadManyArgs({ paths: ['a.ts', ''] })).toThrow('non-empty');
  });
});
