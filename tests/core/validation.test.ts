import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveSafePath,
  validateSmartReadArgs,
  validateReadSymbolArgs,
  validateReadRangeArgs,
  validateReadDiffArgs,
  validateFindUsagesArgs,
  validateSmartReadManyArgs,
  validateOutlineArgs,
  validateProjectOverviewArgs,
  validateModuleInfoArgs,
  validateCodeAuditArgs,
  isDangerousRoot,
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

describe('validateFindUsagesArgs', () => {
  it('accepts valid args', () => {
    expect(validateFindUsagesArgs({ symbol: 'MyClass' }).symbol).toBe('MyClass');
  });

  it('throws on missing symbol', () => {
    expect(() => validateFindUsagesArgs({})).toThrow('symbol');
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

describe('validateFindUsagesArgs (v1.1 filters)', () => {
  it('accepts symbol only (backward compatible)', () => {
    const result = validateFindUsagesArgs({ symbol: 'Foo' });
    expect(result.symbol).toBe('Foo');
    expect(result.scope).toBeUndefined();
    expect(result.kind).toBeUndefined();
    expect(result.limit).toBeUndefined();
    expect(result.lang).toBeUndefined();
  });

  it('accepts all filter params', () => {
    const result = validateFindUsagesArgs({
      symbol: 'MyService',
      scope: 'src/Domain/',
      kind: 'usages',
      limit: 100,
      lang: 'typescript',
    });
    expect(result.scope).toBe('src/Domain/');
    expect(result.kind).toBe('usages');
    expect(result.limit).toBe(100);
    expect(result.lang).toBe('typescript');
  });

  it('throws on invalid kind', () => {
    expect(() => validateFindUsagesArgs({ symbol: 'X', kind: 'invalid' })).toThrow('kind');
  });

  it('throws on limit out of range', () => {
    expect(() => validateFindUsagesArgs({ symbol: 'X', limit: 0 })).toThrow('limit');
    expect(() => validateFindUsagesArgs({ symbol: 'X', limit: 501 })).toThrow('limit');
  });
});

describe('validateOutlineArgs', () => {
  it('accepts path only', () => {
    const result = validateOutlineArgs({ path: 'src/' });
    expect(result.path).toBe('src/');
    expect(result.recursive).toBeUndefined();
    expect(result.max_depth).toBeUndefined();
  });

  it('accepts recursive + max_depth', () => {
    const result = validateOutlineArgs({ path: 'src/', recursive: true, max_depth: 3 });
    expect(result.recursive).toBe(true);
    expect(result.max_depth).toBe(3);
  });

  it('throws on missing path', () => {
    expect(() => validateOutlineArgs({})).toThrow('path');
  });

  it('throws on max_depth out of range', () => {
    expect(() => validateOutlineArgs({ path: 'src/', max_depth: 0 })).toThrow('max_depth');
    expect(() => validateOutlineArgs({ path: 'src/', max_depth: 6 })).toThrow('max_depth');
  });
});

describe('validateProjectOverviewArgs', () => {
  it('returns empty object for no args', () => {
    const result = validateProjectOverviewArgs({});
    expect(result.include).toBeUndefined();
  });

  it('returns empty object for null', () => {
    const result = validateProjectOverviewArgs(null);
    expect(result.include).toBeUndefined();
  });

  it('accepts valid include sections', () => {
    const result = validateProjectOverviewArgs({ include: ['stack', 'ci'] });
    expect(result.include).toEqual(['stack', 'ci']);
  });

  it('throws on invalid include section', () => {
    expect(() => validateProjectOverviewArgs({ include: ['stack', 'invalid'] })).toThrow('include');
  });

  it('throws on non-array include', () => {
    expect(() => validateProjectOverviewArgs({ include: 'stack' })).toThrow('array');
  });
});

describe('validateModuleInfoArgs', () => {
  it('accepts module only (defaults check to all)', () => {
    const result = validateModuleInfoArgs({ module: 'auth' });
    expect(result.module).toBe('auth');
    expect(result.check).toBe('all');
  });

  it('accepts valid check values', () => {
    for (const check of ['deps', 'dependents', 'api', 'unused-deps', 'all']) {
      const result = validateModuleInfoArgs({ module: 'x', check });
      expect(result.check).toBe(check);
    }
  });

  it('throws on missing module', () => {
    expect(() => validateModuleInfoArgs({})).toThrow('module');
  });

  it('throws on empty module', () => {
    expect(() => validateModuleInfoArgs({ module: '' })).toThrow('module');
  });

  it('throws on invalid check', () => {
    expect(() => validateModuleInfoArgs({ module: 'x', check: 'invalid' })).toThrow('check');
  });

  it('throws on null args', () => {
    expect(() => validateModuleInfoArgs(null)).toThrow('object');
  });
});

describe('validateCodeAuditArgs', () => {
  it('accepts check=todo', () => {
    const result = validateCodeAuditArgs({ check: 'todo' });
    expect(result.check).toBe('todo');
  });

  it('accepts check=pattern with pattern and lang', () => {
    const result = validateCodeAuditArgs({ check: 'pattern', pattern: 'console.log($$$)', lang: 'typescript' });
    expect(result.check).toBe('pattern');
    expect(result.pattern).toBe('console.log($$$)');
    expect(result.lang).toBe('typescript');
  });

  it('throws on missing check', () => {
    expect(() => validateCodeAuditArgs({})).toThrow('check');
  });

  it('throws on invalid check value', () => {
    expect(() => validateCodeAuditArgs({ check: 'invalid' })).toThrow('check');
  });
});

describe('isDangerousRoot', () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;

  const setHome = (home: string | undefined, userProfile: string | undefined) => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
  };

  afterEach(() => {
    setHome(savedHome, savedUserProfile);
  });

  it('flags posix system roots', () => {
    setHome('/home/me', undefined);
    for (const root of ['/', '/tmp', '/var', '/Users', '/home', '/root']) {
      expect(isDangerousRoot(root), root).toBe(true);
    }
  });

  it('flags posix roots with a trailing separator', () => {
    setHome('/home/me', undefined);
    expect(isDangerousRoot('/tmp/')).toBe(true);
    expect(isDangerousRoot('/var//')).toBe(true);
  });

  it('flags the posix home directory, with or without a trailing separator', () => {
    setHome('/home/me', undefined);
    expect(isDangerousRoot('/home/me')).toBe(true);
    expect(isDangerousRoot('/home/me/')).toBe(true);
  });

  it('allows a real posix project directory', () => {
    setHome('/home/me', undefined);
    expect(isDangerousRoot('/home/me/proj')).toBe(false);
    expect(isDangerousRoot('/Users/me/proj')).toBe(false);
  });

  // Issue #65 — Windows roots reached the indexer because the guard only
  // stripped forward slashes and compared the raw string.
  it('flags a whole Windows drive in either separator style', () => {
    setHome(undefined, 'C:\\Users\\TAKUMA');
    expect(isDangerousRoot('C:\\')).toBe(true);
    expect(isDangerousRoot('C:/')).toBe(true);
  });

  it('flags C:\\Users in either separator style', () => {
    setHome(undefined, 'C:\\Users\\TAKUMA');
    expect(isDangerousRoot('C:\\Users')).toBe(true);
    expect(isDangerousRoot('C:/Users')).toBe(true);
    expect(isDangerousRoot('C:\\Users\\')).toBe(true);
  });

  it('flags the Windows home directory regardless of separator or case', () => {
    setHome(undefined, 'C:\\Users\\TAKUMA');
    expect(isDangerousRoot('C:\\Users\\TAKUMA')).toBe(true);
    expect(isDangerousRoot('C:/Users/TAKUMA')).toBe(true);
    expect(isDangerousRoot('C:\\Users\\TAKUMA\\')).toBe(true);
    expect(isDangerousRoot('c:\\users\\takuma')).toBe(true);
  });

  it('allows a real Windows project directory', () => {
    setHome(undefined, 'C:\\Users\\TAKUMA');
    expect(isDangerousRoot('C:\\Users\\TAKUMA\\proj')).toBe(false);
    expect(isDangerousRoot('C:/Users/TAKUMA/proj')).toBe(false);
    expect(isDangerousRoot('D:\\work\\repo')).toBe(false);
  });
});
