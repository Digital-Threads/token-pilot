/**
 * module_route reads the binary's json first: its `empty_reason` says why
 * there is no path. The text form says "Run 'ast-index rebuild'" even when
 * the project simply has no module graph, and mermaid/dot print that same
 * prose instead of a diagram.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleModuleRoute } from '../../src/handlers/module-route.js';

const empty = (reason: string) => ({ from: 'a', to: 'b', paths: [], count: 0, truncated: false, empty_reason: reason });

function stub(json: object, modules: Array<{ name: string; path: string }> = [], rendered = 'RENDERED') {
  return {
    isDisabled: () => false,
    isOversized: () => false,
    modules: vi.fn(async () => modules),
    moduleRoute: vi.fn(async (o: { format?: string }) => (o.format === 'json' ? JSON.stringify(json) : rendered)),
  } as any;
}

describe('module_route explains an empty result by its real reason', () => {
  it('not_indexed in a project without modules: no module graph, no rebuild advice', async () => {
    const text = (await handleModuleRoute({ from: 'a', to: 'b' }, '/p', stub(empty('not_indexed')))).content[0].text;

    expect(text).toMatch(/no modules/i);
    expect(text).not.toMatch(/rebuild/);
  });

  it('not_indexed with modules present: the dependency graph is missing — rebuild', async () => {
    const ast = stub(empty('not_indexed'), [{ name: 'core', path: 'core' }]);
    const text = (await handleModuleRoute({ from: 'a', to: 'b' }, '/p', ast)).content[0].text;

    expect(text).toMatch(/rebuild/);
  });

  it('missing module: says which and lists the available ones', async () => {
    const ast = stub(empty('missing_module_from'), [{ name: 'core', path: 'core' }, { name: 'app', path: 'app' }]);
    const text = (await handleModuleRoute({ from: 'nope', to: 'app' }, '/p', ast)).content[0].text;

    expect(text).toMatch(/"nope" is not in the index/);
    expect(text).toContain('core');
  });

  it('unreachable: the modules are not connected', async () => {
    const text = (await handleModuleRoute({ from: 'net', to: 'app', maxDepth: 8 }, '/p', stub(empty('unreachable')))).content[0].text;

    expect(text).toMatch(/does not depend on "app".*8 hops/);
  });

  it('mermaid and dot stay diagrams when there is no path', async () => {
    const mermaid = (await handleModuleRoute({ from: 'a', to: 'b', format: 'mermaid' }, '/p', stub(empty('not_indexed')))).content[0].text;
    const dot = (await handleModuleRoute({ from: 'a', to: 'b', format: 'dot' }, '/p', stub(empty('not_indexed')))).content[0].text;

    expect(mermaid).toMatch(/^```mermaid\nflowchart LR\n {2}%% No path: /);
    expect(dot).toMatch(/^digraph module_route \{\n {2}\/\/ No path: /);
  });

  it('a found path is rendered in the requested format', async () => {
    const found = { from: 'a', to: 'b', paths: [{ hops: [], length: 1 }], count: 1, truncated: false };
    const ast = stub(found, [], '```mermaid\nflowchart LR\n  n0 --> n1\n```');
    const text = (await handleModuleRoute({ from: 'a', to: 'b', format: 'mermaid' }, '/p', ast)).content[0].text;

    expect(text).toBe('```mermaid\nflowchart LR\n  n0 --> n1\n```');
    expect(ast.moduleRoute).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'mermaid' }));
  });

  it('says when more paths exist than were returned', async () => {
    const found = { from: 'a', to: 'b', paths: [{ hops: [], length: 1 }], count: 1, truncated: true };
    const text = (await handleModuleRoute({ from: 'a', to: 'b' }, '/p', stub(found, [], 'a → b'))).content[0].text;

    expect(text).toMatch(/more paths exist/);
  });
});
