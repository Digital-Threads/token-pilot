import { describe, expect, it, vi } from 'vitest';
import { handleModuleInfo } from '../../src/handlers/module-info.js';

describe('module_info accuracy', () => {
  it('resolves the exact module, not the first pattern match, and prints relative API paths', async () => {
    const ast = {
      isDisabled: () => false,
      isOversized: () => false,
      modules: vi.fn(async () => [
        { name: 'core-utils', path: 'core-utils' },
        { name: 'core', path: 'core' },
      ]),
      moduleDeps: async () => [],
      moduleDependents: async () => [],
      moduleApi: async () => [
        { kind: 'class', name: 'Core', signature: 'class Core {', file: 'core/src/main/kotlin/c/Core.kt', line: 3 },
      ],
      unusedDeps: async () => [],
    } as any;

    const text = (await handleModuleInfo({ module: 'core' }, '/p', ast)).content[0].text;

    expect(text).toContain('MODULE: core (core)');
    expect(text).toContain('(core/src/main/kotlin/c/Core.kt:3)');
    expect(text).not.toContain('..');
  });

  it('lists all modules with an empty pattern when the module is unknown', async () => {
    const modules = vi.fn(async (pattern?: string) =>
      pattern === 'nope' ? [] : [{ name: 'core', path: 'core' }],
    );
    const ast = { isDisabled: () => false, isOversized: () => false, modules } as any;

    const text = (await handleModuleInfo({ module: 'nope' }, '/p', ast)).content[0].text;

    expect(text).toContain('Available modules (1)');
    expect(modules).toHaveBeenLastCalledWith('');
  });
});
