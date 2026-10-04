import { spawn } from 'node:child_process';
import type { TestSummaryArgs } from '../core/validation.js';
import { estimateTokens } from '../core/token-estimator.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Declared but not written yet (vitest/jest `it.todo`). */
  todo?: number;
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
  const timeoutMs = args.timeout ?? 60000;
  const run = await runCommand(command, projectRoot, timeoutMs);

  if (run.spawnError) {
    return {
      content: [{ type: 'text', text: `Command failed to start: ${command}\n${run.spawnError}` }],
      rawTokens: 0,
    };
  }

  const rawTokens = estimateTokens(run.output);
  const runner = args.runner ?? detectRunner(command, run.output);
  const result = parseTestOutput(run.output, runner);
  const formatted = formatTestSummary(result, run, runner, rawTokens, timeoutMs);

  return {
    content: [{ type: 'text', text: formatted }],
    rawTokens,
  };
}

// ──────────────────────────────────────────────
// Running the command
// ──────────────────────────────────────────────

interface RunResult {
  /** stdout and stderr, interleaved in arrival order. */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The environment the command would have in the user's terminal: the MCP
 * server's own, minus what Claude Code's plugin launcher and token-pilot put
 * there (CLAUDE_PLUGIN_ROOT and friends change how this project's own tests
 * behave).
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(TOKEN_PILOT_|CLAUDE_PLUGIN_)/.test(key)) continue;
    out[key] = value;
  }

  return { ...out, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' };
}

/**
 * Kill the command and everything it started: its process group on Unix.
 * Windows has no process groups, so killing the shell (cmd.exe) would
 * orphan the test runner: `taskkill /T` walks the tree. Best-effort, never throws.
 */
export function killTree(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      process.kill(-pid, signal);
    }
  } catch { /* already gone */ }
}

/**
 * Run through the shell, like a terminal would: env prefixes (`CI=1 npm
 * test`) and `&&` work. Its own process group (a tree kill on Windows), so a
 * timeout kills the test runner too, not just the shell.
 */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((done) => {
    const ownGroup = process.platform !== 'win32';
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;

    const finish = (r: { exitCode: number | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ output: Buffer.concat(chunks).toString('utf8'), timedOut, ...r });
    };

    const child = spawn(command, {
      cwd,
      env: childEnv(process.env),
      shell: true,
      detached: ownGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) killTree(child.pid, signal);
    };

    const collect = (b: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      chunks.push(b);
      size += b.length;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => {
        kill('SIGKILL');
        finish({ exitCode: null }); // a survivor may hold the pipes open — stop waiting
      }, 2000).unref();
    }, timeoutMs);

    child.on('error', (err) => finish({ exitCode: null, spawnError: err.message }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
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
  if (cmd.includes('node --test') || cmd.includes('node:test')) return 'node';

  // Detect from output
  const lower = output.toLowerCase();
  if (lower.includes('vitest') || lower.includes('vite')) return 'vitest';
  if (lower.includes('jest')) return 'jest';
  if (lower.includes('pytest') || (lower.includes('=== ') && lower.includes(' passed'))) return 'pytest';
  if (lower.includes('phpunit')) return 'phpunit';
  if (lower.includes('--- fail:') || lower.includes('--- pass:') || lower.includes('ok  \t')) return 'go';
  // node:test prints a TAP summary footer: "# tests N" + "# pass N" + "# fail N".
  if (/^#\s*tests\s+\d+/m.test(output) && /^#\s*pass\s+\d+/m.test(output)) return 'node';

  return 'generic';
}

// ──────────────────────────────────────────────
// Parsers
// ──────────────────────────────────────────────

/** Runners with a parser of their own; the rest go through parseGeneric. */
const PARSED_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'phpunit', 'go', 'cargo', 'node']);

export function parseTestOutput(output: string, runner: string): TestResult {
  switch (runner) {
    case 'vitest':
      return parseVitest(output);
    case 'jest':
      return parseJest(output);
    case 'pytest':
      return parsePytest(output);
    case 'phpunit':
      return parsePhpunit(output);
    case 'go':
      return parseGoTest(output);
    case 'cargo':
      return parseCargoTest(output);
    case 'node':
      return parseNodeTest(output);
    default:
      return parseGeneric(output);
  }
}

function lastMatch(output: string, re: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const m of output.matchAll(re)) last = m;
  return last;
}

/** "1 failed | 3 passed | 2 todo" or "1 failed, 3 passed, 4 total" → counts by word. */
function countWords(segment: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of segment.matchAll(/(\d+)\s+(failed|passed|skipped|todo|pending|total)\b/g)) {
    counts[m[2]] = (counts[m[2]] ?? 0) + parseInt(m[1], 10);
  }
  return counts;
}

function applyCounts(result: TestResult, counts: Record<string, number>, total?: number): void {
  result.failed = counts.failed ?? 0;
  result.passed = counts.passed ?? 0;
  result.skipped = (counts.skipped ?? 0) + (counts.pending ?? 0);
  if (counts.todo) result.todo = counts.todo;
  result.total = total ?? counts.total ?? result.failed + result.passed + result.skipped + (result.todo ?? 0);
}

const SUMMARY_LINE = /^\s*(Test Files|Tests:?|Test Suites:|Snapshots:|Time:|Start at|Duration)\s/;
const CODE_FRAME = /^\s*(>\s*)?\d*\s*\|/;

/**
 * The error under a failure header: up to three message lines plus where it
 * happened. Stops at the next header, a separator or the run summary.
 */
function errorBelow(lines: string[], from: number, isHeader: (line: string) => boolean): string {
  const message: string[] = [];
  let location = '';

  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    if (isHeader(lines[i]) || SUMMARY_LINE.test(lines[i]) || line.startsWith('⎯')) break;
    if (!line || CODE_FRAME.test(lines[i])) continue;

    if (line.startsWith('❯ ') || line.startsWith('at ')) {
      if (!location) location = line.replace(/^❯ /, 'at ');
      continue;
    }
    if (message.length < 3 && !location) message.push(line);
  }

  return [...message, location].filter(Boolean).join('\n').substring(0, 400);
}

function failuresFromHeaders(output: string, header: RegExp): FailedTest[] {
  const lines = output.split('\n');
  const failures: FailedTest[] = [];
  const seen = new Set<string>();

  lines.forEach((line, i) => {
    const m = line.match(header);
    if (!m) return;
    const name = m[1].trim().replace(/\s*\[ .* \]$/, '').substring(0, 200);
    if (seen.has(name)) return;
    seen.add(name);
    failures.push({ name, error: errorBelow(lines, i + 1, l => header.test(l)) });
  });

  return failures;
}

/** "× name 3ms" / "✕ name (3 ms)" run-list lines — used only when there are no failure blocks. */
function failuresFromMarks(output: string): FailedTest[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/^\s*[×✕]\s+(.+?)(?:\s+\(?\d+\s*ms\)?)?\s*$/gm)) names.add(m[1]);
  return [...names].map(name => ({ name: name.substring(0, 200), error: '' }));
}

function parseVitest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  //      Tests  1 failed | 3 passed | 1 skipped | 3 todo (8)
  const tests = lastMatch(output, /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/gm);
  if (tests) applyCounts(result, countWords(tests[1]), parseInt(tests[2], 10));

  //  Test Files  1 failed | 1 passed (2)
  const files = lastMatch(output, /^\s*Test Files\s+.*\((\d+)\)\s*$/gm);
  if (files) result.suites = parseInt(files[1], 10);

  const duration = lastMatch(output, /^\s*Duration\s+([\d.]+\s*(?:ms|s|m|h))\b/gm);
  if (duration) result.duration = duration[1];

  // A passing run may print "FAIL " / "× " in its logs — only look for
  // failures when it failed, or when there is no summary to tell.
  if (result.failed > 0 || !tests) {
    result.failures = failuresFromHeaders(output, /^\s*FAIL\s+(.+)$/);
    if (result.failures.length === 0) result.failures = failuresFromMarks(output);
  }

  return result;
}

function parseJest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // Tests:       1 failed, 1 skipped, 1 todo, 1 passed, 4 total
  const tests = lastMatch(output, /^\s*Tests:\s+(.+)$/gm);
  if (tests) applyCounts(result, countWords(tests[1]));

  // Test Suites: 1 failed, 1 total
  const suites = lastMatch(output, /^\s*Test Suites:\s+.*?(\d+) total/gm);
  if (suites) result.suites = parseInt(suites[1], 10);

  const duration = lastMatch(output, /^\s*Time:\s+([\d.]+\s*(?:ms|s|m|h))\b/gm);
  if (duration) result.duration = duration[1];

  if (result.failed > 0 || !tests) {
    result.failures = failuresFromHeaders(output, /^\s*●\s+(.+)$/);
    if (result.failures.length === 0) result.failures = failuresFromMarks(output);
  }

  return result;
}

function parsePytest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // === 5 passed, 1 failed, 2 skipped in 1.23s === — the last such line; the
  // first ===…=== line is "test session starts".
  const summary = lastMatch(output, /^=+\s*(.*?\d+\s+(?:passed|failed|skipped|errors?|xfailed|xpassed|deselected).*?)\s*=+\s*$/gm);
  if (summary) {
    const parts = summary[1];
    const num = (re: RegExp) => parseInt(parts.match(re)?.[1] ?? '0', 10);
    const duration = parts.match(/in\s+([\d.]+s)/);

    result.passed = num(/(\d+)\s+passed/);
    // A collection or setup error fails the run too.
    result.failed = num(/(\d+)\s+failed/) + num(/(\d+)\s+errors?\b/);
    result.skipped = num(/(\d+)\s+skipped/);
    result.total = result.passed + result.failed + result.skipped;
    if (duration) result.duration = duration[1];
  }

  // FAILED tests/test_foo.py::test_bar - AssertionError
  const failedPattern = /^(?:FAILED|ERROR)\s+(\S+)\s*-?\s*(.*)/gm;
  const seen = new Set<string>();
  let match;
  while ((match = failedPattern.exec(output)) !== null) {
    const [, name, error] = match;
    if (seen.has(name)) continue;
    seen.add(name);
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

function parseNodeTest(output: string): TestResult {
  const result: TestResult = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };

  // node:test (`node --test`) prints a TAP summary footer:
  //   # tests 2
  //   # pass 2
  //   # fail 0
  //   # skipped 0
  const num = (re: RegExp): number | null => {
    const m = output.match(re);
    return m ? parseInt(m[1], 10) : null;
  };
  const pass = num(/^#\s*pass\s+(\d+)/m);
  const fail = num(/^#\s*fail\s+(\d+)/m);
  const skip = num(/^#\s*skipped\s+(\d+)/m);
  const tests = num(/^#\s*tests\s+(\d+)/m);

  if (pass !== null || fail !== null) {
    result.passed = pass ?? 0;
    result.failed = fail ?? 0;
    result.skipped = skip ?? 0;
    result.total = tests ?? result.passed + result.failed + result.skipped;
  } else {
    // No footer (truncated output) — count the TAP point lines instead.
    result.passed = (output.match(/^ok\s+\d+/gm) ?? []).length;
    result.failed = (output.match(/^not ok\s+\d+/gm) ?? []).length;
    result.total = result.passed + result.failed + result.skipped;
  }

  // Failure names come from the TAP point: "not ok 3 - the test name".
  const failPattern = /^not ok\s+\d+\s*-\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = failPattern.exec(output)) !== null) {
    result.failures.push({ name: match[1].trim(), error: '' });
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

const NO_TESTS = /No test files found|No tests found|no tests ran|collected 0 items/i;

/** The last lines of the output — what a reader needs when nothing was parsed. */
function outputTail(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(-8)
    .map(line => `  ${line.substring(0, 200)}`);
}

function formatTestSummary(
  result: TestResult,
  run: RunResult,
  runner: string,
  rawTokens: number,
  timeoutMs: number,
): string {
  const parsed = result.total > 0 || result.failures.length > 0;
  const exitFailed = !run.timedOut && run.exitCode !== 0;

  let status: string;
  if (run.timedOut) status = `⏱ TIMEOUT after ${timeoutMs}ms`;
  else if (!parsed && NO_TESTS.test(run.output)) status = '⚠ NO TESTS FOUND';
  else if (result.failed > 0 || exitFailed) status = '❌ FAIL';
  else if (!parsed) status = '⚠ NO TEST RESULTS';
  else status = '✅ PASS';

  const lines: string[] = [`TEST RESULT: ${status} (${runner})`, ''];

  if (run.timedOut) {
    lines.push('The command was killed; anything below covers only the output before that.');
  }
  if (!PARSED_RUNNERS.has(runner) && runner !== 'generic') {
    lines.push(`NOTE: no ${runner} parser — counts come from generic patterns and may be incomplete.`);
  }

  if (parsed) {
    const parts: string[] = [`${result.total} total`, `${result.passed} passed`];
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    if (result.todo) parts.push(`${result.todo} todo`);
    if (result.duration) parts.push(result.duration);
    if (result.suites) parts.push(`${result.suites} suites`);
    lines.push(parts.join(' | '));
  }

  if (exitFailed) {
    lines.push(`Exit code: ${run.exitCode}`);
  }

  if (result.failures.length > 0) {
    lines.push('');
    lines.push('FAILURES:');
    for (const f of result.failures.slice(0, 10)) {
      lines.push(`  ✗ ${f.name}`);
      for (const errLine of f.error ? f.error.split('\n').slice(0, 4) : []) {
        lines.push(`    ${errLine}`);
      }
    }
    if (result.failures.length > 10) {
      lines.push(`  ... and ${result.failures.length - 10} more failures`);
    }
  }

  // Nothing parsed, or a non-zero exit no test explains: show where it ended.
  if (!parsed || (exitFailed && result.failed === 0)) {
    lines.push('');
    if (exitFailed) {
      lines.push(`Command exited with code ${run.exitCode}${parsed ? ' though no test failed' : ' — no test counts in its output'}. Last lines:`);
    } else {
      lines.push('No test counts in the output. Last lines:');
    }
    lines.push(...outputTail(run.output));
  }

  lines.push('');
  lines.push(`RAW OUTPUT: ~${rawTokens} tokens → test_summary: ~${estimateTokens(lines.join('\n'))} tokens`);

  return lines.join('\n');
}
