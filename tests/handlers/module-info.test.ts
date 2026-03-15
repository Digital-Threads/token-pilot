import { describe, it, expect } from 'vitest';
import { handleModuleInfo } from '../../src/handlers/module-info.js';

describe('handleModuleInfo', () => {
  const root = '/repo';

  it('returns degraded guidance when ast-index is unavailable', async () => {
    const result = await handleModuleInfo(
      { module: 'auth' },
      root,
      { isDisabled: () => true, isOversized: () => false } as any,
    );
    expect(result.content[0].text).toContain('module_info requires ast-index');
  });

  it('reports available modules when the requested module cannot be resolved', async () => {
    const result = await handleModuleInfo(
      { module: 'missing' },
      root,
      {
        isDisabled: () => false,
        isOversized: () => false,
        modules: async (pattern?: string) => pattern ? [] : [{ name: 'auth', path: 'src/auth' }],
      } as any,
    );

    expect(result.content[0].text).toContain('Module "missing" not found');
    expect(result.content[0].text).toContain('Available modules (1):');
  });

  it('formats all module sections from ast-index results', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      modules: async () => [{ name: 'auth', path: 'src/auth' }],
      moduleDeps: async () => [{ name: 'db', path: 'src/db', type: 'direct' }],
      moduleDependents: async () => [{ name: 'api', path: 'src/api' }],
      moduleApi: async () => [{ kind: 'function', name: 'login', signature: 'login()', file: '/repo/src/auth/login.ts', line: 12 }],
      unusedDeps: async () => [{ name: 'legacy', path: 'src/legacy', reason: 'unused import' }],
    } as any;

    const result = await handleModuleInfo({ module: 'auth' }, root, astIndex);
    const text = result.content[0].text;

    expect(text).toContain('MODULE: auth (src/auth)');
    expect(text).toContain('DEPENDENCIES (1):');
    expect(text).toContain('DEPENDENTS (1 modules depend on this):');
    expect(text).toContain('PUBLIC API (1 symbols):');
    expect(text).toContain('UNUSED DEPENDENCIES (1):');
  });

  it('supports single-check mode and empty results', async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      modules: async () => [{ name: 'auth', path: 'src/auth' }],
      moduleDeps: async () => [],
      moduleDependents: async () => [],
      moduleApi: async () => [],
      unusedDeps: async () => [],
    } as any;

    const result = await handleModuleInfo({ module: 'auth', check: 'deps' }, root, astIndex);
    expect(result.content[0].text).toContain('DEPENDENCIES: none detected');
    expect(result.content[0].text).not.toContain('PUBLIC API');
  });
});
