/**
 * test_summary against recorded runner output and real short child processes
 * (audit 1.0.2, W2 item 9). vitest and pytest outputs were recorded from
 * vitest 4.1.8 / pytest 9.0.2; the jest one follows jest 29's reporter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseTestOutput, handleTestSummary } from '../../src/handlers/test-summary.js';

const VITEST_PASS_TODO = [
  '',
  ' RUN  v4.1.8 /tmp/vt',
  '',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  2 passed | 1 skipped | 2 todo (5)',
  '   Start at  15:14:14',
  '   Duration  168ms (transform 18ms, setup 0ms, import 35ms, tests 3ms, environment 0ms)',
  '',
].join('\n');

const VITEST_FAIL_TODO = '\n RUN  v4.1.8 /tmp/vt\n\n ❯ fail.test.ts (3 tests | 1 failed | 1 todo) 6ms\n   × breaks 4ms\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  fail.test.ts > breaks\nAssertionError: expected 1 to be 2 // Object.is equality\n\n- Expected\n+ Received\n\n- 2\n+ 1\n\n ❯ fail.test.ts:3:32\n      1| import { it, expect } from \'vitest\';\n      2| it(\'ok\', () => { expect(1).toBe(1); });\n      3| it(\'breaks\', () => { expect(1).toBe(2); });\n       |                                ^\n      4| it.todo(\'soon\');\n      5|\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\n\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 3 passed | 1 skipped | 3 todo (8)\n   Start at  15:15:47\n   Duration  170ms (transform 43ms, setup 0ms, import 62ms, tests 8ms, environment 0ms)\n\n';

const JEST_FAIL = [
  'FAIL tests/sum.test.js',
  '  sum',
  '    ✓ adds (2 ms)',
  '    ✕ subtracts (3 ms)',
  '    ○ skipped later',
  '    ✎ todo something',
  '',
  '  ● sum › subtracts',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: 1',
  '    Received: 2',
  '',
  '      4 |   it(\'subtracts\', () => {',
  '    > 5 |     expect(sub(3, 1)).toBe(1);',
  '        |                       ^',
  '',
  '      at Object.toBe (tests/sum.test.js:5:23)',
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       1 failed, 1 skipped, 1 todo, 1 passed, 4 total',
  'Snapshots:   0 total',
  'Time:        0.512 s',
  'Ran all test suites.',
].join('\n');

const PYTEST_FAIL = [
  '============================= test session starts ==============================',
  'platform linux -- Python 3.12.3, pytest-9.0.2, pluggy-1.6.0',
  'rootdir: /tmp/py',
  'collected 4 items',
  '',
  'test_a.py .Fs.                                                           [100%]',
  '',
  '=================================== FAILURES ===================================',
  '___________________________________ test_bad ___________________________________',
  '',
  '    def test_bad():',
  '>       assert 1 == 2',
  'E       assert 1 == 2',
  '',
  'test_a.py:7: AssertionError',
  '=========================== short test summary info ============================',
  'FAILED test_a.py::test_bad - assert 1 == 2',
  '==================== 1 failed, 2 passed, 1 skipped in 0.01s ====================',
].join('\n');

describe('test_summary parsers — recorded output', () => {
  it('vitest: a passing run with todo/skip keeps its counts', () => {
    const r = parseTestOutput(VITEST_PASS_TODO, 'vitest');
    expect(r).toMatchObject({ total: 5, passed: 2, failed: 0, skipped: 1, todo: 2, suites: 1 });
    expect(r.failures).toEqual([]);
    expect(r.duration).toBe('168ms');
  });

  it('vitest: a failing run with todo — right counts, each failure once, no summary lines in the error', () => {
    const r = parseTestOutput(VITEST_FAIL_TODO, 'vitest');
    expect(r).toMatchObject({ total: 8, passed: 3, failed: 1, skipped: 1, todo: 3, suites: 2 });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].name).toBe('fail.test.ts > breaks');
    expect(r.failures[0].error).toContain('AssertionError: expected 1 to be 2');
    expect(r.failures[0].error).not.toMatch(/Test Files|Tests\s+1 failed|Duration/);
  });

  it('vitest: a passing run that prints "FAIL " and "× " lists no failures', () => {
    const noisy = ' stdout | a.test.ts > logs\nFAIL  this is just a log line\n   × not a failure either\n' + VITEST_PASS_TODO;
    const r = parseTestOutput(noisy, 'vitest');
    expect(r.failed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it('vitest: "134ms" stays "134ms"', () => {
    const r = parseTestOutput(VITEST_PASS_TODO.replace('168ms (transform', '134ms (transform'), 'vitest');
    expect(r.duration).toBe('134ms');
  });

  it('jest: summary with todo and skipped, one failure from its ● block', () => {
    const r = parseTestOutput(JEST_FAIL, 'jest');
    expect(r).toMatchObject({ total: 4, passed: 1, failed: 1, skipped: 1, todo: 1, suites: 1 });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].name).toBe('sum › subtracts');
    expect(r.failures[0].error).toContain('expect(received).toBe(expected)');
    expect(r.duration).toBe('0.512 s');
  });

  it('pytest: the real output (session header first) is counted', () => {
    const r = parseTestOutput(PYTEST_FAIL, 'pytest');
    expect(r).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1 });
    expect(r.failures.map(f => f.name)).toEqual(['test_a.py::test_bad']);
    expect(r.duration).toBe('0.01s');
  });
});

describe('test_summary — real child processes', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const run = async (command: string, extra: Record<string, unknown> = {}) =>
    (await handleTestSummary({ command, ...extra } as never, process.cwd())).content[0].text;

  it('a command killed by the timeout says TIMEOUT', async () => {
    const text = await run('node -e "setTimeout(() => {}, 20000)"', { timeout: 1000 });
    expect(text).toMatch(/TIMEOUT/);
    expect(text).not.toMatch(/✅ PASS/);
  }, 15000);

  it('the child does not inherit Claude plugin / token-pilot variables', async () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/plugins/cache/token-pilot';
    process.env.TOKEN_PILOT_PROFILE = 'nav';
    const text = await run('node -e "console.log(\'ROOT=\' + (process.env.CLAUDE_PLUGIN_ROOT ?? \'unset\') + \' PROFILE=\' + (process.env.TOKEN_PILOT_PROFILE ?? \'unset\'))"');
    expect(text).toContain('ROOT=unset PROFILE=unset');
  });

  it('a command that is not a test run gets no PASS verdict', async () => {
    const text = await run('node -e "console.log(\'hello\')"');
    expect(text).not.toMatch(/✅ PASS/);
    expect(text).toMatch(/NO TEST RESULTS/);
    expect(text).toContain('hello');
  });

  it('"No test files found" is reported as such, not as one failed test', async () => {
    const text = await run('node -e "console.log(\'No test files found, exiting with code 1\'); process.exit(1)"', { runner: 'vitest' });
    expect(text).toMatch(/NO TESTS FOUND/);
    expect(text).not.toMatch(/1 failed/);
  });

  it('a crash without test output is a FAIL with its exit code, and no invented counts', async () => {
    const text = await run('node -e "console.error(\'boom\'); process.exit(3)"');
    expect(text).toMatch(/❌ FAIL/);
    expect(text).toContain('Exit code: 3');
    expect(text).toContain('boom');
    expect(text).not.toMatch(/\d+ failed/);
  });

  it('env prefixes and && work (run through a shell)', async () => {
    const text = await run('FOO=bar node -e "console.log(process.env.FOO)" && node -e "console.log(\'second\')"');
    expect(text).not.toMatch(/ENOENT/);
    expect(text).toContain('bar');
    expect(text).toContain('second');
  });

  it('runners without a dedicated parser say so', async () => {
    const text = await run('node -e "console.log(\'3 examples, 0 failures\')"', { runner: 'rspec' });
    expect(text).toMatch(/no rspec parser/i);
  });
});
