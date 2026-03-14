import { describe, it, expect } from 'vitest';
import { parseGitLog, categorizeCommit } from '../../src/handlers/smart-log.js';
import { validateSmartLogArgs, validateTestSummaryArgs } from '../../src/core/validation.js';

describe('parseGitLog', () => {
  const SEP = '<<<SEP>>>';
  const F = '<<<F>>>';

  it('parses a single commit with numstat', () => {
    const raw = [
      `${SEP}abc1234${F}2026-03-14${F}John${F}feat: add login`,
      '10\t2\tsrc/auth.ts',
      '5\t0\tsrc/utils.ts',
    ].join('\n');

    const entries = parseGitLog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe('abc1234');
    expect(entries[0].date).toBe('2026-03-14');
    expect(entries[0].author).toBe('John');
    expect(entries[0].message).toBe('feat: add login');
    expect(entries[0].files).toEqual(['src/auth.ts', 'src/utils.ts']);
    expect(entries[0].insertions).toBe(15);
    expect(entries[0].deletions).toBe(2);
    expect(entries[0].category).toBe('feat');
  });

  it('parses multiple commits', () => {
    const raw = [
      `${SEP}aaa${F}2026-03-14${F}Alice${F}fix: broken link`,
      '1\t1\tREADME.md',
      `${SEP}bbb${F}2026-03-13${F}Bob${F}refactor: extract utils`,
      '20\t15\tsrc/core.ts',
      '30\t0\tsrc/utils.ts',
    ].join('\n');

    const entries = parseGitLog(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].hash).toBe('aaa');
    expect(entries[0].category).toBe('fix');
    expect(entries[1].hash).toBe('bbb');
    expect(entries[1].category).toBe('refactor');
    expect(entries[1].insertions).toBe(50);
    expect(entries[1].deletions).toBe(15);
  });

  it('handles binary file stats (- marks)', () => {
    const raw = [
      `${SEP}ccc${F}2026-03-14${F}Dev${F}add image`,
      '-\t-\tassets/logo.png',
    ].join('\n');

    const entries = parseGitLog(raw);
    expect(entries[0].insertions).toBe(0);
    expect(entries[0].deletions).toBe(0);
    expect(entries[0].files).toEqual(['assets/logo.png']);
  });

  it('returns empty for empty input', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('   ')).toEqual([]);
  });

  it('handles commit with no files', () => {
    const raw = `${SEP}ddd${F}2026-03-14${F}Dev${F}chore: empty commit`;
    const entries = parseGitLog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toEqual([]);
    expect(entries[0].insertions).toBe(0);
  });
});

describe('categorizeCommit', () => {
  it('detects conventional commit prefixes', () => {
    expect(categorizeCommit('feat: add login')).toBe('feat');
    expect(categorizeCommit('fix: broken link')).toBe('fix');
    expect(categorizeCommit('refactor: extract utils')).toBe('refactor');
    expect(categorizeCommit('docs: update README')).toBe('docs');
    expect(categorizeCommit('test: add unit tests')).toBe('test');
    expect(categorizeCommit('chore: bump deps')).toBe('chore');
    expect(categorizeCommit('style: format code')).toBe('style');
    expect(categorizeCommit('perf: optimize query')).toBe('perf');
  });

  it('detects conventional commits with scope', () => {
    expect(categorizeCommit('feat(auth): add OAuth')).toBe('feat');
    expect(categorizeCommit('fix(ui): button color')).toBe('fix');
  });

  it('detects version bumps as feat', () => {
    expect(categorizeCommit('v0.10.0: smart_diff + explore_area')).toBe('feat');
    expect(categorizeCommit('0.9.0: new features')).toBe('feat');
  });

  it('detects keywords in non-conventional messages', () => {
    expect(categorizeCommit('Add new feature for users')).toBe('feat');
    expect(categorizeCommit('Fix broken login flow')).toBe('fix');
    expect(categorizeCommit('Rename variables for clarity')).toBe('refactor');
    expect(categorizeCommit('Update documentation')).toBe('docs');
    expect(categorizeCommit('Add unit tests for auth')).toBe('test');
    expect(categorizeCommit('Optimize database queries')).toBe('perf');
  });

  it('returns other for unrecognized messages', () => {
    expect(categorizeCommit('WIP')).toBe('other');
    expect(categorizeCommit('misc changes')).toBe('other');
  });
});

describe('validateSmartLogArgs', () => {
  it('accepts empty args', () => {
    const result = validateSmartLogArgs({});
    expect(result).toEqual({});
  });

  it('accepts all valid params', () => {
    const result = validateSmartLogArgs({ path: 'src/', count: 20, ref: 'main' });
    expect(result.path).toBe('src/');
    expect(result.count).toBe(20);
    expect(result.ref).toBe('main');
  });

  it('throws on count out of range', () => {
    expect(() => validateSmartLogArgs({ count: 0 })).toThrow('count');
    expect(() => validateSmartLogArgs({ count: 100 })).toThrow('count');
  });

  it('throws on non-string path', () => {
    expect(() => validateSmartLogArgs({ path: 123 })).toThrow('path');
  });
});

describe('validateTestSummaryArgs', () => {
  it('accepts valid command', () => {
    const result = validateTestSummaryArgs({ command: 'npm test' });
    expect(result.command).toBe('npm test');
  });

  it('accepts command with runner', () => {
    const result = validateTestSummaryArgs({ command: 'npx vitest', runner: 'vitest' });
    expect(result.runner).toBe('vitest');
  });

  it('accepts custom timeout', () => {
    const result = validateTestSummaryArgs({ command: 'npm test', timeout: 120000 });
    expect(result.timeout).toBe(120000);
  });

  it('throws on missing command', () => {
    expect(() => validateTestSummaryArgs({})).toThrow('command');
  });

  it('throws on invalid runner', () => {
    expect(() => validateTestSummaryArgs({ command: 'test', runner: 'invalid' })).toThrow('runner');
  });

  it('throws on timeout out of range', () => {
    expect(() => validateTestSummaryArgs({ command: 'test', timeout: 500 })).toThrow('timeout');
  });

  it('throws on null args', () => {
    expect(() => validateTestSummaryArgs(null)).toThrow('object');
  });
});
