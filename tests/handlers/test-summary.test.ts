import { describe, it, expect } from 'vitest';
import { parseTestOutput, detectRunner, handleTestSummary } from '../../src/handlers/test-summary.js';

describe('detectRunner', () => {
  it('detects vitest from command', () => {
    expect(detectRunner('npx vitest', '')).toBe('vitest');
    expect(detectRunner('vitest run', '')).toBe('vitest');
  });

  it('detects jest from command', () => {
    expect(detectRunner('npx jest', '')).toBe('jest');
    expect(detectRunner('jest --coverage', '')).toBe('jest');
  });

  it('detects pytest from command', () => {
    expect(detectRunner('pytest', '')).toBe('pytest');
    expect(detectRunner('python -m pytest', '')).toBe('pytest');
  });

  it('detects go test from command', () => {
    expect(detectRunner('go test ./...', '')).toBe('go');
  });

  it('detects cargo test from command', () => {
    expect(detectRunner('cargo test', '')).toBe('cargo');
  });

  it('detects from output when command is generic', () => {
    expect(detectRunner('npm test', 'vitest v3.2.4')).toBe('vitest');
    expect(detectRunner('npm test', 'PASS tests/foo.test.js\nJest')).toBe('jest');
  });

  it('returns generic for unknown', () => {
    expect(detectRunner('npm test', 'some output')).toBe('generic');
  });
});

describe('parseTestOutput — vitest/jest', () => {
  it('parses all-passing vitest output', () => {
    const output = [
      '✓ tests/core/validation.test.ts (45 tests) 15ms',
      '✓ tests/handlers/non-code.test.ts (10 tests) 78ms',
      '',
      'Test Files  2 passed (2)',
      '     Tests  55 passed (55)',
      '  Duration  980ms',
    ].join('\n');

    const result = parseTestOutput(output, 'vitest');
    expect(result.passed).toBe(55);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(55);
    expect(result.suites).toBe(2);
    expect(result.failures).toHaveLength(0);
  });

  it('parses vitest output with failures', () => {
    const output = [
      'FAIL  tests/foo.test.ts > describe > should work',
      'AssertionError: expected 1 to be 2',
      '',
      'Test Files  1 failed | 2 passed (3)',
      '     Tests  1 failed | 54 passed (55)',
      '  Duration  1.5s',
    ].join('\n');

    const result = parseTestOutput(output, 'vitest');
    expect(result.passed).toBe(54);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(55);
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseTestOutput — pytest', () => {
  it('parses passing pytest output', () => {
    const output = '========================= 10 passed in 1.23s =========================';
    const result = parseTestOutput(output, 'pytest');
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(10);
    expect(result.duration).toBe('1.23s');
  });

  it('parses pytest with failures', () => {
    const output = [
      'FAILED tests/test_auth.py::test_login - AssertionError: wrong status',
      'FAILED tests/test_api.py::test_endpoint - ValueError',
      '========================= 3 passed, 2 failed in 2.5s =========================',
    ].join('\n');

    const result = parseTestOutput(output, 'pytest');
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.total).toBe(5);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].name).toContain('test_login');
  });

  it('parses pytest with skipped', () => {
    const output = '========================= 5 passed, 2 skipped in 0.8s =========================';
    const result = parseTestOutput(output, 'pytest');
    expect(result.passed).toBe(5);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(7);
  });
});

describe('parseTestOutput — phpunit', () => {
  it('parses OK result', () => {
    const output = 'OK (25 tests, 40 assertions)';
    const result = parseTestOutput(output, 'phpunit');
    expect(result.total).toBe(25);
    expect(result.passed).toBe(25);
    expect(result.failed).toBe(0);
  });

  it('parses failure result', () => {
    const output = [
      '1) AppTest\\AuthTest::testLogin',
      'FAILURES!',
      'Tests: 25, Assertions: 40, Failures: 3',
    ].join('\n');

    const result = parseTestOutput(output, 'phpunit');
    expect(result.total).toBe(25);
    expect(result.failed).toBe(3);
    expect(result.passed).toBe(22);
    expect(result.failures).toHaveLength(1);
  });
});

describe('parseTestOutput — go', () => {
  it('parses go test output', () => {
    const output = [
      '--- PASS: TestFoo (0.00s)',
      '--- PASS: TestBar (0.01s)',
      '--- FAIL: TestBaz (0.00s)',
      'PASS',
    ].join('\n');

    const result = parseTestOutput(output, 'go');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.failures[0].name).toBe('TestBaz');
  });
});

describe('parseTestOutput — cargo', () => {
  it('parses cargo test output', () => {
    const output = 'test result: ok. 15 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out';
    const result = parseTestOutput(output, 'cargo');
    expect(result.passed).toBe(15);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(17);
  });
});

describe('parseTestOutput — generic', () => {
  it('extracts basic counts from unknown format', () => {
    const output = '12 tests, 10 passed, 2 failed';
    const result = parseTestOutput(output, 'generic');
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(2);
    expect(result.total).toBe(12);
  });
});

describe('handleTestSummary', () => {
  it('marks a crashing command as failed even without structured test output', async () => {
    const result = await handleTestSummary(
      { command: 'node --eval "console.error(\'boom\'); process.exit(1)"' },
      process.cwd(),
    );

    const text = result.content[0].text;
    expect(text).toContain('TEST RESULT: ❌ FAIL');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('Command exited with code 1');
    expect(text).toContain('boom');
  });
});
