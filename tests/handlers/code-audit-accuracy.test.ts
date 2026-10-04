/**
 * code_audit with what the client really returns: project-relative paths
 * (resolved against the project root, not the server's cwd), entries
 * without symbol names for deprecated/annotations, and caps that must be
 * reported.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCodeAudit } from '../../src/handlers/code-audit.js';

describe('code_audit accuracy', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-audit-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'Svc.java'),
      ['@Service', 'public class Svc {', '    @Deprecated', '', '    public void oldMethod() {}', '}', ''].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = () => ({
    isDisabled: () => false,
    isOversized: () => false,
  });

  it('prints project-relative paths for relative client paths', async () => {
    const ast = {
      ...base(),
      todo: async () => [{ kind: 'TODO', file: 'src/a.ts', line: 4, text: 'fix me' }],
    } as any;
    const text = (await handleCodeAudit({ check: 'todo' }, root, ast)).content[0].text;

    expect(text).toContain('src/a.ts:4');
    expect(text).not.toContain('..');
  });

  it('names the declaration a deprecated marker or annotation belongs to', async () => {
    const ast = {
      ...base(),
      deprecated: async () => [{ kind: '', name: '', file: 'src/Svc.java', line: 3 }],
      annotations: async () => [{ kind: '', name: '', file: 'src/Svc.java', line: 1, annotation: 'Service' }],
    } as any;

    const dep = (await handleCodeAudit({ check: 'deprecated' }, root, ast)).content[0].text;
    expect(dep).toContain('src/Svc.java:3');
    expect(dep).toContain('public void oldMethod() {}');

    const ann = (await handleCodeAudit({ check: 'annotations', name: 'Service' }, root, ast)).content[0].text;
    expect(ann).toContain('L1: public class Svc {');
  });

  it('asks for one more than the limit and says when there are more', async () => {
    const entries = Object.assign(
      [
        { kind: 'TODO', file: 'src/a.ts', line: 1, text: 'a' },
        { kind: 'TODO', file: 'src/a.ts', line: 2, text: 'b' },
      ],
      { truncated: true },
    );
    const ast = { ...base(), todo: vi.fn(async () => entries) } as any;

    const text = (await handleCodeAudit({ check: 'todo', limit: 2 }, root, ast)).content[0].text;

    expect(ast.todo).toHaveBeenCalledWith(2);
    expect(text).toMatch(/more may exist/);
  });

  it('pattern mode counts matches, uses project-relative paths and reports truncation', async () => {
    const ast = {
      ...base(),
      agrep: vi.fn(async () => [
        { file: 'src/a.ts', line: 2, text: 'console.log(a);' },
        { file: 'src/a.ts', line: 6, text: 'console.log( … (3 lines)' },
        { file: 'src/b.ts', line: 1, text: 'console.log(b);' },
      ]),
    } as any;

    const text = (await handleCodeAudit({ check: 'pattern', pattern: 'console.log($$$A)', limit: 2 }, root, ast))
      .content[0].text;

    expect(text).toMatch(/showing 2 of 3 matches/);
    expect(text).toContain('src/a.ts:');
    expect(text).not.toContain('..');
  });
});
