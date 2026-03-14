import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestSummaryArgs } from '../core/validation.js';
import { estimateTokens } from '../core/token-estimator.js';

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration?: string;
  failures: FailedTest[];
  suites?: number;
}

export interface FailedTest {
  name: string;
  file?: string;
  error: string;
}

// ──────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────

export async function handleTestSummary(
  args: TestSummaryArgs,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; rawTokens: number }> {
  const command = args.command;
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
  const bin = parts[0];
  const binArgs = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

  let rawOutput: string;
  let exitCode: number | null = 0;

  try {
    const { stdout, stderr } = await execFileAsync(bin, binArgs, {
      cwd: projectRoot,
      timeout: args.timeout ?? 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
    });
    rawOutput = stdout + '\n' + stderr;
  } catch (err: unknown) {
    // Test runners exit with non-zero when tests fail — that's expected
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    rawOutput = (execErr.stdout ?? '') + '\n' + (execErr.stderr ?? '');
    exitCode = execErr.code ?? 1;

    // If no output at all, it's a real error
    if (!rawOutput.trim()) {
      return {
        content: [{ type: 'text', text: `Command failed: ${command}\n${err instanceof Error ? err.message : String(err)}` }],
        rawTokens: 0,
      };
    }
  }

  const rawTokens = estimateTokens(rawOutput);
  const runner = args.runner ?? detectRunner(command, rawOutput);
  const result = parseTestOutput(rawOutput, runner);
  const formatted = formatTestSummary(result, command, runner, rawTokens);

  return {
    content: [{ type: 'text', text: formatted }],
    rawTokens,
  };
}

// ──────────────────────────────────────────────
// Runner detection
// ──────────────────────────────────────────────

export function detectRunner(command: string, output: string): string {
  const cmd = command.toLowerCase();

  if (cmd.includes('vitest')) return 'vitest';
  if (cmd.includes('jest')) return 'jest';
  if (cmd.includes('pytest') || cmd.includes('python -m pytest')) return 'pytest';
  if (cmd.includes('phpunit')) return 'phpunit';
  if (cmd.includes('cargo test')) return 'cargo';
  if (cmd.includes('go test')) return 'go';
  if (cmd.includes('rspec')) return 'rspec';
  if (cmd.includes('mocha')) return 'mocha';

  // Detect from output
  const lower = output.toLowerCase();
  if (lower.includes('vitest') || lower.includes('vite')) return 'vitest';
  if (lower.includes('jest')) return 'jest';
  if (lower.includes('pytest') || (lower.includes('=== ') && lower.includes(' passed'))) return 'pytest';
  if (lower.includes('phpunit')) return 'phpunit';
  if (lower.includes('--- fail:') || lower.includes('--- pass:') || lower.includes('ok  \t')) return 'go';

  return 'generic';
}

// ──────────────────────────────────────────────
// Parsers
// ──────────────────────────────────────────────

export function parseTestOutput(output: string, runner: string): TestResult {
  switch (runner) {
    case 'vitest':
    case 'jest':
      return parseVitestJest(output);
    case 'pytest':
      return parsePytest(output);
    case 'phpunit':
      return parsePhpunit(output);
    case 'go':
      return parseGoTest(output);
    case 'cargo':
      return parseCargoTest(output);
    default:
      return parseGeneric(output);
  }
}

function parseVitestJest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // Test Files  12 passed (12)  OR  Tests  170 passed (170)  OR  Tests  3 failed (3)
  const testsLine = output.match(/Tests?\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*)?(?:\|?\s*(\d+)\s+skipped)?\s*\((\d+)\)/);
  if (testsLine) {
    result.failed = parseInt(testsLine[1] ?? '0', 10);
    result.passed = parseInt(testsLine[2] ?? '0', 10);
    result.skipped = parseInt(testsLine[3] ?? '0', 10);
    result.total = parseInt(testsLine[4], 10);
  }

  // Test Files count
  const suitesLine = output.match(/Test Files\s+(?:\d+\s+failed\s*\|?\s*)?(\d+)\s+passed\s*\((\d+)\)/);
  if (suitesLine) {
    result.suites = parseInt(suitesLine[2], 10);
  }

  // Duration
  const duration = output.match(/Duration\s+([\d.]+\w?\s*(?:\([^)]+\))?)/);
  if (duration) {
    result.duration = duration[1].trim();
  }

  // Parse failures
  // FAIL  tests/foo.test.ts > describe > test name
  const failBlocks = output.split(/(?:FAIL|✕|×)\s+/).slice(1);
  for (const block of failBlocks.slice(0, 10)) {
    const lines = block.split('\n');
    const firstLine = lines[0]?.trim() ?? '';
    const errorLines: string[] = [];

    for (let i = 1; i < Math.min(lines.length, 8); i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      if (line.startsWith('at ') || line.startsWith('❯')) continue;
      if (line.startsWith('⎯') || line.startsWith('─')) break;
      errorLines.push(line);
    }

    if (firstLine) {
      result.failures.push({
        name: firstLine.substring(0, 200),
        error: errorLines.join('\n').substring(0, 300),
      });
    }
  }

  return result;
}

function parsePytest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // === 5 passed, 1 failed, 2 skipped in 1.23s ===
  const summary = output.match(/=+\s*(.*?)\s*=+\s*$/m);
  if (summary) {
    const parts = summary[1];
    const passed = parts.match(/(\d+)\s+passed/);
    const failed = parts.match(/(\d+)\s+failed/);
    const skipped = parts.match(/(\d+)\s+skipped/);
    const duration = parts.match(/in\s+([\d.]+s)/);

    result.passed = parseInt(passed?.[1] ?? '0', 10);
    result.failed = parseInt(failed?.[1] ?? '0', 10);
    result.skipped = parseInt(skipped?.[1] ?? '0', 10);
    result.total = result.passed + result.failed + result.skipped;
    if (duration) result.duration = duration[1];
  }

  // FAILED tests/test_foo.py::test_bar - AssertionError
  const failedPattern = /^FAILED\s+(\S+)\s*-?\s*(.*)/gm;
  let match;
  while ((match = failedPattern.exec(output)) !== null) {
    const [, name, error] = match;
    result.failures.push({
      name: name.substring(0, 200),
      error: (error || '').substring(0, 300),
    });
  }

  return result;
}

function parsePhpunit(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // OK (5 tests, 10 assertions) or  FAILURES! Tests: 5, Assertions: 10, Failures: 2, Errors: 1
  const ok = output.match(/OK\s*\((\d+)\s+test/);
  if (ok) {
    result.total = parseInt(ok[1], 10);
    result.passed = result.total;
  }

  const failures = output.match(/Tests:\s*(\d+).*?Failures:\s*(\d+)/);
  if (failures) {
    result.total = parseInt(failures[1], 10);
    result.failed = parseInt(failures[2], 10);

    // PHPUnit also reports Errors separately from Failures
    const errors = output.match(/Errors:\s*(\d+)/);
    if (errors) {
      result.failed += parseInt(errors[1], 10);
    }

    result.passed = result.total - result.failed - result.skipped;
  }

  const duration = output.match(/Time:\s*([\d.:]+\s*\w*)/);
  if (duration) result.duration = duration[1].trim();

  // 1) TestClass::testMethod
  const failPattern = /^\d+\)\s+(\S+::\S+)/gm;
  let match;
  while ((match = failPattern.exec(output)) !== null) {
    result.failures.push({
      name: match[1].substring(0, 200),
      error: '',
    });
  }

  return result;
}

function parseGoTest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  const passLines = output.match(/^---\s+PASS:/gm);
  const failLines = output.match(/^---\s+FAIL:/gm);
  const skipLines = output.match(/^---\s+SKIP:/gm);

  result.passed = passLines?.length ?? 0;
  result.failed = failLines?.length ?? 0;
  result.skipped = skipLines?.length ?? 0;
  result.total = result.passed + result.failed + result.skipped;

  // --- FAIL: TestFoo (0.00s)
  const failPattern = /^---\s+FAIL:\s+(\S+)\s+\(([^)]+)\)/gm;
  let match;
  while ((match = failPattern.exec(output)) !== null) {
    result.failures.push({
      name: match[1],
      error: `duration: ${match[2]}`,
    });
  }

  // If zero counted, try "ok" / "FAIL" summary lines
  if (result.total === 0) {
    const okCount = (output.match(/^ok\s+/gm) ?? []).length;
    const failCount = (output.match(/^FAIL\s+/gm) ?? []).length;
    result.passed = okCount;
    result.failed = failCount;
    result.total = okCount + failCount;
  }

  return result;
}

function parseCargoTest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out
  const summary = output.match(/test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/);
  if (summary) {
    result.passed = parseInt(summary[1], 10);
    result.failed = parseInt(summary[2], 10);
    result.skipped = parseInt(summary[3], 10);
    result.total = result.passed + result.failed + result.skipped;
  }

  // Cargo outputs two "failures:" sections:
  // 1. Detail section: "failures:\n\n---- test_name stdout ----\n..."
  // 2. Name-list section: "failures:\n    test_name_1\n    test_name_2\n"
  // We want the name-list section (the last one before "test result:")
  const failSections = output.split(/^failures:\s*$/m).slice(1);
  for (const section of failSections) {
    // The name-list section has indented test names without "---- ... ----"
    const lines = section.split('\n').filter(l => l.trim());
    const isNameList = lines.length > 0 && lines.every(l => /^\s+\S+/.test(l) && !l.includes('----'));
    if (isNameList) {
      for (const line of lines.slice(0, 10)) {
        result.failures.push({ name: line.trim(), error: '' });
      }
      break;
    }
  }

  return result;
}

function parseGeneric(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // Try common patterns
  const passedMatch = output.match(/(\d+)\s+(?:passed|passing|ok|success)/i);
  const failedMatch = output.match(/(\d+)\s+(?:failed|failing|error|fail)/i);
  const skippedMatch = output.match(/(\d+)\s+(?:skipped|pending|ignored)/i);
  const totalMatch = output.match(/(\d+)\s+(?:total|tests?|specs?)\b/i);

  result.passed = parseInt(passedMatch?.[1] ?? '0', 10);
  result.failed = parseInt(failedMatch?.[1] ?? '0', 10);
  result.skipped = parseInt(skippedMatch?.[1] ?? '0', 10);
  result.total = totalMatch
    ? parseInt(totalMatch[1], 10)
    : result.passed + result.failed + result.skipped;

  return result;
}

// ──────────────────────────────────────────────
// Formatter
// ──────────────────────────────────────────────

function formatTestSummary(result: TestResult, command: string, runner: string, rawTokens: number): string {
  const lines: string[] = [];

  const status = result.failed > 0 ? '❌ FAIL' : '✅ PASS';
  lines.push(`TEST RESULT: ${status} (${runner})`);
  lines.push('');

  // Stats line
  const parts: string[] = [];
  parts.push(`${result.total} total`);
  parts.push(`${result.passed} passed`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.duration) parts.push(`${result.duration}`);
  if (result.suites) parts.push(`${result.suites} suites`);
  lines.push(parts.join(' | '));

  // Failed tests detail
  if (result.failures.length > 0) {
    lines.push('');
    lines.push('FAILURES:');
    for (const f of result.failures.slice(0, 10)) {
      lines.push(`  ✗ ${f.name}`);
      if (f.error) {
        for (const errLine of f.error.split('\n').slice(0, 3)) {
          lines.push(`    ${errLine}`);
        }
      }
    }
    if (result.failures.length > 10) {
      lines.push(`  ... and ${result.failures.length - 10} more failures`);
    }
  }

  lines.push('');
  lines.push(`RAW OUTPUT: ~${rawTokens} tokens → test_summary: ~${estimateTokens(lines.join('\n'))} tokens`);

  return lines.join('\n');
}

