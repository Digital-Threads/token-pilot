/**
 * related_files against realistic ast-index data: paths come back relative
 * to the project root, TS sources import `./x.js`, and an importer is a
 * file whose import resolves to the target — not one that happens to use
 * a same-named symbol.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleRelatedFiles } from '../../src/handlers/related-files.js';
import { parseJsImports } from '../../src/ast-index/parser.js';
import { readFile } from 'node:fs/promises';

const FILES: Record<string, string> = {
  'src/core/cache.ts': "import { hash } from './hash.js';\nimport type { Opts } from '../types.js';\nexport function cache() {}\n",
  'src/core/hash.ts': 'export function hash() {}\n',
  'src/types.ts': 'export interface Opts {}\n',
  'src/server.ts': "import {\n  other,\n  cache,\n} from './core/cache.js';\ncache();\n",
  'src/legacy/cache-user.ts': "import { cache } from './old-cache.js';\ncache();\n",
  'src/legacy/old-cache.ts': 'export function cache() {}\n',
  'tests/core/cache.test.ts': "import { cache } from '../../src/core/cache.js';\n",
  'tests/core/cache-key.test.ts': "import { key } from '../../src/core/key.js';\n",
  'tests/core/mycache.test.ts': '',
};

describe('related_files resolves paths, imports and tests', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-related-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(join(root, rel, '..'), { recursive: true });
      await writeFile(join(root, rel), content);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function astIndex() {
    return {
      isDisabled: () => false,
      isOversized: () => false,
      // Like the real client: relative or absolute path, JS read from disk.
      fileImports: async (p: string) =>
        parseJsImports(await readFile(p.startsWith('/') ? p : join(root, p), 'utf-8')),
      outline: async () => ({ symbols: [{ name: 'cache' }] }),
      // ast-index returns project-relative paths; `cache` also matches the legacy one.
      refs: async () => ({
        definitions: [],
        imports: [],
        usages: [
          { path: 'src/server.ts', line: 5, name: 'cache' },
          { path: 'src/legacy/cache-user.ts', line: 2, name: 'cache' },
        ],
      }),
      search: async () => [
        { file: 'src/server.ts', line: 4, text: "} from './core/cache.js';" },
        { file: 'tests/core/cache.test.ts', line: 1, text: "import { cache } from '../../src/core/cache.js';" },
      ],
      listFiles: async () => Object.keys(FILES),
    } as any;
  }

  it('lists project-relative imports, mapping .js specifiers to .ts and keeping type imports', async () => {
    const result = await handleRelatedFiles({ path: 'src/core/cache.ts' }, root, astIndex());

    expect(result.meta.imports).toEqual(['src/core/hash.ts', 'src/types.ts']);
  });

  it('counts as importers only files whose import resolves to the target', async () => {
    const result = await handleRelatedFiles({ path: 'src/core/cache.ts' }, root, astIndex());

    expect(result.meta.importedBy).toEqual(['src/server.ts', 'tests/core/cache.test.ts']);
    expect(result.content[0].text).not.toContain('legacy');
    expect(result.content[0].text).not.toContain('..');
  });

  it('finds tests by exact name or by import, not by substring', async () => {
    const result = await handleRelatedFiles({ path: 'src/core/cache.ts' }, root, astIndex());

    expect(result.meta.tests).toEqual(['tests/core/cache.test.ts']);
  });

  it('finds a test by name even when it is not an importer', async () => {
    await writeFile(join(root, 'tests', 'core', 'cache.test.ts'), '// empty\n');
    const ast = astIndex();
    ast.search = async () => [];
    const result = await handleRelatedFiles({ path: 'src/core/cache.ts' }, root, ast);

    expect(result.meta.tests).toEqual(['tests/core/cache.test.ts']);
  });
});
