import { describe, it, expect } from 'vitest';
import { handleCodeAudit } from '../../src/handlers/code-audit.js';

describe('handleCodeAudit', () => {
  const root = '/repo';

  it('returns degraded guidance when ast-index is unavailable', async () => {
    const result = await handleCodeAudit(
      { check: 'todo' },
      root,
      { isDisabled: () => true, isOversized: () => false } as any,
    );
    expect(result.content[0].text).toContain('ast-index is not available');
  });

  it('formats structural pattern search results and handles empty matches', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      agrep: async () => [{ file: '/repo/src/a.ts', line: 10, text: 'print(foo)' }],
    } as any;

    const hit = await handleCodeAudit({ check: 'pattern', pattern: 'print($$$ARGS)', lang: 'python' }, root, astIndex);
    expect(hit.content[0].text).toContain('PATTERN SEARCH: "print($$$ARGS)" (python)');
    expect(hit.content[0].text).toContain('src/a.ts:');

    const none = await handleCodeAudit(
      { check: 'pattern', pattern: 'noop' },
      root,
      { ...astIndex, agrep: async () => [] } as any,
    );
    expect(none.content[0].text).toContain('No matches found');
  });

  it('formats todo, deprecated, annotations, all, and unknown checks', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      todo: async () => [{ kind: 'TODO', file: '/repo/src/a.ts', line: 4, text: 'fix me' }],
      deprecated: async () => [{ kind: 'function', name: 'oldFn', file: '/repo/src/a.ts', line: 8, message: 'use newFn' }],
      annotations: async () => [{ kind: 'class', name: 'UserService', file: '/repo/src/a.ts', line: 2 }],
      agrep: async () => [],
    } as any;

    const todo = await handleCodeAudit({ check: 'todo' }, root, astIndex);
    expect(todo.content[0].text).toContain('TODO/FIXME COMMENTS: 1 found');

    const deprecated = await handleCodeAudit({ check: 'deprecated' }, root, astIndex);
    expect(deprecated.content[0].text).toContain('DEPRECATED SYMBOLS: 1 found');

    const annotations = await handleCodeAudit({ check: 'annotations', name: '@Injectable' }, root, astIndex);
    expect(annotations.content[0].text).toContain('ANNOTATIONS @Injectable: 1 found');

    const all = await handleCodeAudit({ check: 'all' }, root, astIndex);
    expect(all.content[0].text).toContain('CODE AUDIT SUMMARY');
    expect(all.content[0].text).toContain('DEPRECATED: 1 symbols');

    const unknown = await handleCodeAudit({ check: 'weird' as any }, root, astIndex);
    expect(unknown.content[0].text).toContain('Unknown check type');
  });

  it('returns a pattern-search error fallback when agrep throws', async () => {
    const result = await handleCodeAudit(
      { check: 'pattern', pattern: 'x' },
      root,
      {
        isDisabled: () => false,
        isOversized: () => false,
        agrep: async () => { throw new Error('sg missing'); },
      } as any,
    );

    expect(result.content[0].text).toContain('PATTERN SEARCH ERROR');
    expect(result.content[0].text).toContain('sg missing');
  });
});
