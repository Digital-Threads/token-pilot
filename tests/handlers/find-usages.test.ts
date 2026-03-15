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
