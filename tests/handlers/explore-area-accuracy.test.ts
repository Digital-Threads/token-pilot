/**
 * explore_area imports/tests against a realistic layout: tests live in
 * tests/<dir>/, sources import `./x.js`, and ast-index answers with
 * project-relative paths.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleExploreArea } from '../../src/handlers/explore-area.js';
import { parseJsImports } from '../../src/ast-index/parser.js';

const FILES: Record<string, string> = {
  'src/handlers/find-usages.ts': "import { a } from '../core/confidence.js';\nimport { z } from 'zod';\nexport function handleFindUsages() {}\n",
  'src/handlers/call-tree.ts': "import { b } from '../core/confidence.js';\nexport function handleCallTree() {}\n",
  'src/handlers/call-tree.test.ts': "import { it } from 'vitest';\nimport { handleCallTree } from './call-tree.js';\n",
  'src/core/confidence.ts': 'export const a = 1;\nexport const b = 2;\n',
  'src/server.ts': "import {\n  handleFindUsages,\n} from './handlers/find-usages.js';\n",
  'src/unrelated.ts': "// mentions find-usages but imports nothing from the area\nimport { a } from './core/confidence.js';\n",
  'tests/handlers/find-usages.test.ts': "import { handleFindUsages } from '../../src/handlers/find-usages.js';\n",
  'tests/handlers/find-usages-accuracy.test.ts': "import { handleFindUsages } from '../../src/handlers/find-usages.js';\n",
  'tests/core/confidence.test.ts': "import { a } from '../../src/core/confidence.js';\n",
  'tests/top-level.test.ts': "import { x } from '../src/x.js';\n",
};

describe('explore_area imports and tests', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-explore-area-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(join(root, rel, '..'), { recursive: true });
      await writeFile(join(root, rel), content);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function astIndex() {
    const read = (p: string) => readFile(p.startsWith('/') ? p : join(root, p), 'utf-8');
    return {
      isAvailable: () => true,
      isDisabled: () => false,
      isOversized: () => false,
      fileImports: async (p: string) => parseJsImports(await read(p)),
      listFiles: async () => Object.keys(FILES),
      // content search over project files, relative paths like the binary
      search: async (q: string) => {
        const hits: Array<{ file: string; line: number; text: string }> = [];
        for (const [rel, content] of Object.entries(FILES)) {
          content.split('\n').forEach((text, i) => {
            if (text.includes(q)) hits.push({ file: rel, line: i + 1, text: text.trim() });
          });
        }
        return hits;
      },
      refs: async () => ({ definitions: [], imports: [], usages: [] }),
      outline: async () => null,
    } as any;
  }

  it('lists only the tests of this area: co-located, tests/<dir>/ by name or by import', async () => {
    const result = await handleExploreArea(
      { path: 'src/handlers', include: ['tests'] },
      root,
      astIndex(),
    );

    expect(result.meta.testFiles).toEqual([
      'src/handlers/call-tree.test.ts',
      'tests/handlers/find-usages-accuracy.test.ts',
      'tests/handlers/find-usages.test.ts',
    ]);
  });

  it('fills IMPORTED BY with files whose imports resolve into the area', async () => {
    const result = await handleExploreArea(
      { path: 'src/handlers', include: ['imports'] },
      root,
      astIndex(),
    );

    expect(result.meta.importedBy).toEqual(['src/server.ts']);
  });

  it('reads imports of source files only and names real files', async () => {
    const result = await handleExploreArea(
      { path: 'src/handlers', include: ['imports'] },
      root,
      astIndex(),
    );

    expect(result.meta.externalDeps).toEqual(['zod']);
    expect(result.meta.internalDeps).toEqual(['src/core/confidence.ts']);
  });
});
