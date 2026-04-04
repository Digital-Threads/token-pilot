import { describe, it, expect } from 'vitest';
import { handleFindUsages } from '../../src/handlers/find-usages.js';

describe('handleFindUsages', () => {
  it('filters substring matches, applies lang filter, and exposes meta files', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      isAvailable: () => true,
      refs: async () => ({
        definitions: [{ path: 'src/user.ts', line: 1, signature: 'export function user() {}', name: 'user' }],
        imports: [{ path: 'src/consumer.ts', line: 3, context: 'import { user } from "./user"', name: 'user' }],
        usages: [{ path: 'src/consumer.ts', line: 8, context: 'return user()', name: 'user' }],
      }),
      search: async () => ([
        { file: 'src/consumer.ts', line: 3, text: 'import { user } from "./user"' },
        { file: 'src/consumer.ts', line: 10, text: 'const username = buildUsername()' },
        { file: 'src/secondary.ts', line: 4, text: 'user(profile)' },
        { file: 'src/secondary.py', line: 5, text: 'user(profile)' },
      ]),
    } as any;

    const result = await handleFindUsages(
      { symbol: 'user', lang: 'typescript' },
      astIndex,
    );

    const text = result.content[0].text;
    expect(text).toContain('REFS: "user" (4 total');
    expect(text).toContain('src/secondary.ts:4');
    expect(text).not.toContain('buildUsername');
    expect(text).not.toContain('src/secondary.py');
    expect(result.meta.files).toEqual([
      'src/consumer.ts',
      'src/secondary.ts',
      'src/user.ts',
    ]);
  });

  it('groups multiple matches in the same file under one header', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      isAvailable: () => true,
      refs: async () => ({
        definitions: [],
        imports: [],
        usages: [
          { path: 'src/app.ts', line: 10, context: 'handleHookRead(a)', name: 'handleHookRead' },
          { path: 'src/app.ts', line: 20, context: 'handleHookRead(b)', name: 'handleHookRead' },
          { path: 'src/other.ts', line: 5, context: 'handleHookRead(c)', name: 'handleHookRead' },
        ],
      }),
      search: async () => [],
    } as any;

    const result = await handleFindUsages({ symbol: 'handleHookRead' }, astIndex);
    const text = result.content[0].text;

    // Multiple matches in same file → grouped under file header
    expect(text).toContain('src/app.ts:');
    expect(text).toContain(':10  handleHookRead(a)');
    expect(text).toContain(':20  handleHookRead(b)');

    // Single match in other file → one line
    expect(text).toContain('src/other.ts:5  handleHookRead(c)');

    // src/app.ts appears only once as a header, not twice
    expect(text.split('src/app.ts').length - 1).toBe(1);
  });

  it('mode=list returns compact file:line output without context snippets', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      isAvailable: () => true,
      refs: async () => ({
        definitions: [{ path: 'src/user.ts', line: 10, signature: 'export function user() {}', name: 'user' }],
        imports: [{ path: 'src/consumer.ts', line: 3, context: 'import { user } from "./user"', name: 'user' }],
        usages: [
          { path: 'src/consumer.ts', line: 8, context: 'return user()', name: 'user' },
          { path: 'src/consumer.ts', line: 15, context: 'user(data)', name: 'user' },
        ],
      }),
      search: async () => [],
    } as any;

    const result = await handleFindUsages(
      { symbol: 'user', mode: 'list' },
      astIndex,
    );

    const text = result.content[0].text;

    // Should contain the "USAGES OF" header
    expect(text).toContain('USAGES OF "user"');

    // Should contain file paths with line numbers
    expect(text).toContain('src/user.ts: L10');
    expect(text).toContain('src/consumer.ts: L3, L8, L15');

    // Should contain the hint
    expect(text).toContain('HINT:');

    // Should NOT contain context code snippets (lines with '>' marker or raw code)
    expect(text).not.toContain('> ');
    expect(text).not.toContain('export function user()');
    expect(text).not.toContain('import { user }');
    expect(text).not.toContain('return user()');

    // meta should reflect the counts
    expect(result.meta.total).toBe(4);
    expect(result.meta.files).toContain('src/user.ts');
    expect(result.meta.files).toContain('src/consumer.ts');
  });

  it('returns disabled guidance when ast-index is unavailable', async () => {
    const astIndex = {
      isDisabled: () => true,
      isOversized: () => false,
    } as any;

    const result = await handleFindUsages({ symbol: 'user' }, astIndex);
    expect(result.content[0].text).toContain('find_usages is disabled');
    expect(result.meta.total).toBe(0);
  });
});
