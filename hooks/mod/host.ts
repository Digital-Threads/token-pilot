/**
 * $-free helpers shared by the mod's handler files.
 *
 * The engine's validator follows `$` only into functions declared at the top
 * of the same file — never across an import — so anything that calls `$`
 * lives in the handler file that needs it. What is shared here takes and
 * returns plain values.
 */

import type { EngineInterface, HookFailure } from 'claude-code'
import { resolveConfig } from '../../src/config/resolve.js'
import { dirname, isAbsolute, join, normalize, relative } from '../../src/core/portable-path.js'
import type { TokenPilotConfig } from '../../src/types.js'

export const PREFIX = 'mcp__plugin_token-pilot_token-pilot__'

/** Same rules as loadConfig: no readable `.token-pilot.json` → defaults plus env overrides. */
export function configFrom(
  raw: string | null,
  env: Readonly<Record<string, string | undefined>>,
): TokenPilotConfig {
  if (raw === null) return resolveConfig(null, env)

  try {
    return resolveConfig(JSON.parse(raw), env)
  } catch {
    return resolveConfig(null, env)
  }
}

/** `path` lies strictly inside `root` (both already resolved). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)

  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Model-facing notes after a tool result — never on a deny or an error. */
export function withContext<R extends { deny?: unknown; isError?: unknown; context?: readonly string[] }>(
  ran: R,
  notes: string[],
): R {
  if (!notes.length || ran.deny !== undefined || ran.isError) return ran

  return { ...ran, context: [...(ran.context ?? []), ...notes] }
}

/**
 * Nearest ancestor of `dir` holding `.git` — a directory for the main
 * checkout, a file for a linked worktree. `exists` is the caller's
 * `p => $.fs.exists(p)`: `$` itself cannot cross a file boundary.
 */
export async function findCheckout(exists: (path: string) => Promise<boolean>, dir: string): Promise<string | null> {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (await exists(join(cur, '.git'))) return cur
    if (dirname(cur) === cur) return null
  }
}

/**
 * Key for read_for_edit bookkeeping: the path inside its own checkout. A
 * subagent prepares `src/a.ts` (the command hook maps it into its worktree)
 * and edits `<worktree>/src/a.ts`; both land on the same key.
 */
export function prepKey(checkout: string | null, absPath: string): string {
  return checkout ? relative(checkout, absPath) : normalize(absPath)
}

/** Same cap as error-log.ts, which archives hook-errors.jsonl for the CLI. */
export const ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024

// Archive by hard link then unlink: the link fails, atomically, when the
// archive name is taken. Where links are not supported, mv -n. find -size
// reads the size without reading the file (busybox wc -c reads it all).
const SH_APPEND = [
  'f=$1 a="${1%.jsonl}.$3.jsonl"',
  'mkdir -p "$(dirname "$f")" || exit 1',
  'if [ -n "$(find "$f" -prune -size +$(($2 - 1))c 2>/dev/null)" ]; then',
  '  { ln "$f" "$a" 2>/dev/null && rm -f "$f"; } || { [ -e "$a" ] || mv -n "$f" "$a" 2>/dev/null; }',
  'fi',
  'cat >> "$f"',
].join('\n')

const NODE_APPEND = [
  "const fs = require('fs'), path = require('path'), [f, max, now] = process.argv.slice(1)",
  'fs.mkdirSync(path.dirname(f), { recursive: true })',
  "const archive = f.replace(/\\.jsonl$/, '.' + now + '.jsonl')",
  'try {',
  '  if (fs.statSync(f).size >= +max) {',
  '    try { fs.linkSync(f, archive); fs.unlinkSync(f) }',
  "    catch (e) { if (e.code !== 'EEXIST' && !fs.existsSync(archive)) fs.renameSync(f, archive) }",
  '  }',
  '} catch {}',
  'fs.appendFileSync(f, fs.readFileSync(0))',
].join('\n')

/**
 * argv that append stdin to `file`, `sh` first and `node` where there is no
 * `sh`. A file of `maxBytes` or more is first archived as `<name>.<now>.jsonl`,
 * as the CLI does; an existing archive is never replaced.
 */
export function appendArgvs(file: string, maxBytes: number, now: number): string[][] {
  return [
    ['sh', '-c', SH_APPEND, 'sh', file, String(maxBytes), String(now)],
    ['node', '-e', NODE_APPEND, file, String(maxBytes), String(now)],
  ]
}

type Run = (argv: string[], init?: { stdin?: string }) => Promise<unknown>

/**
 * Append one line to a log. Only ever appends: the file is never read and
 * rewritten, so a failure loses this line at worst. Never throws — telemetry
 * must not break a tool call. Callers pass `$.process.run` as a closure.
 */
export async function appendLog(run: Run, file: string, line: string, maxBytes: number): Promise<void> {
  for (const argv of appendArgvs(file, maxBytes, Date.now())) {
    try {
      const done = (await run(argv, { stdin: line + '\n' })) as { exitCode?: number } | undefined
      if (done?.exitCode === 0) return
    } catch {
      /* this appender is missing — try the next */
    }
  }
}

/**
 * One hook-errors.jsonl record, in the shape `token-pilot errors` reads. The
 * engine reports a failed hook as { kind, message } — no Error, no stack.
 */
export function errorLine(hook: string, failure: HookFailure | undefined, now: number): string {
  return JSON.stringify({
    ts: now,
    hook,
    level: 'error',
    code: 'mod_hook_failed',
    msg: `${failure?.kind ?? 'throw'}: ${failure?.message ?? 'no message'}`.slice(0, 500),
  })
}

/**
 * A mod hook that throws or overruns is skipped by the engine and the call
 * goes ahead; this records why, in the log `token-pilot errors` reads. `next`
 * here is replay-safe, so nothing beneath runs twice.
 */
export async function caught<E, R>(
  $: EngineInterface,
  e: E,
  next: ((e: E) => Promise<R>) & { readonly error?: HookFailure },
): Promise<R> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    if (home && (await $.env.get('TOKEN_PILOT_NO_ERROR_LOG')) !== '1') {
      const tool = (e as { tool?: unknown } | null)?.tool
      void appendLog(
        (argv, init) => $.process.run(argv, init),
        `${home}/.token-pilot/hook-errors.jsonl`,
        errorLine(`mod:${typeof tool === 'string' ? tool : 'hook'}`, next.error, Date.now()),
        ERROR_LOG_MAX_BYTES,
      )
    }
  } catch {
    /* reporting must never fail the call */
  }

  return next(e)
}

let contextModeTool: string | undefined

/**
 * Note the session's tools as prompt.compose last saw them. The Bash advice
 * can then name context-mode's execute tool exactly as this install has it.
 */
export function noteTools(tools: readonly string[]): void {
  contextModeTool = tools.find(tool => tool.includes('context-mode') && /__(ctx_)?execute$/.test(tool)) ?? contextModeTool
}

export function contextModeToolName(): string | undefined {
  return contextModeTool
}
