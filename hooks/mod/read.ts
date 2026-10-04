/**
 * Read, in-process. A whole-file Read of a big code file gets the file's
 * structural outline (smart_read) back as a normal Read result, with a header
 * that says so — instead of the command hook's refusal the model then has to
 * recover from. Core still reads one line, so Claude Code counts the file as
 * read and a later Edit works. Replaces the hook-read command hook.
 */

import type { EngineInterface, On } from 'claude-code'
import {
  decideReadGate,
  decideReadGateFromStats,
  isCodeFile,
  outlineHeader,
  spanCannotExceed,
} from '../../src/hooks/read-gate.js'
import { computeEffectiveThreshold } from '../../src/hooks/adaptive-threshold.js'
import { estimateTokens } from '../../src/core/token-estimator.js'
import { relative } from '../../src/core/portable-path.js'
import { ROTATION_THRESHOLD_BYTES, tagEvent } from '../../src/core/hook-event.js'
import type { HookEvent } from '../../src/core/event-log.js'
import { appendLog, caught, configFrom, isInside, PREFIX } from './host.js'

export const READ_ACTIONS = ['hook-read']

// $.fs.read rejects files this large; they are measured with wc -l instead.
const FS_READ_MAX = 4 * 1024 * 1024

/**
 * Line count of a file $.fs.read will not return; without `wc`, estimated
 * from its size. null when wc ran and failed: the file cannot be read, and
 * Read is the one to say so.
 */
async function countLines($: EngineInterface, filePath: string, size: number): Promise<number | null> {
  let run
  try {
    run = await $.process.run(['wc', '-l', filePath])
  } catch {
    return Math.ceil(size / 40) // no wc (native Windows)
  }

  const lines = Number.parseInt(run.stdout, 10)

  return run.exitCode === 0 && Number.isFinite(lines) ? lines : null
}

export function registerRead(on: On): void {
  let savedThisSession = 0

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)

    const filePath = String(e.file_path)
    if (!isCodeFile(filePath)) return next(e)

    const root = await $.session.root()
    // Literal names: the engine lists the variables a module reads.
    const env = {
      TOKEN_PILOT_DENY_THRESHOLD: await $.env.get('TOKEN_PILOT_DENY_THRESHOLD'),
      TOKEN_PILOT_ADAPTIVE_THRESHOLD: await $.env.get('TOKEN_PILOT_ADAPTIVE_THRESHOLD'),
      TOKEN_PILOT_ADAPTIVE_BUDGET: await $.env.get('TOKEN_PILOT_ADAPTIVE_BUDGET'),
      TOKEN_PILOT_MODE: await $.env.get('TOKEN_PILOT_MODE'),
      TOKEN_PILOT_BYPASS: await $.env.get('TOKEN_PILOT_BYPASS'),
    }
    const config = configFrom(await $.fs.read(`${root}/.token-pilot.json`).then(String, () => null), env)
    if (config.hooks.mode === 'off') return next(e)

    // Real paths, so a symlink pointing out of the project passes through.
    const realRoot = (await $.fs.stat(root, { resolve: true })).realPath ?? root
    // A missing file is Read's to report, not a hook failure.
    const fileStat = await $.fs.stat(filePath, { resolve: true }).catch(() => null)
    if (!fileStat || !isInside(realRoot, fileStat.realPath ?? filePath)) return next(e)

    const threshold = config.hooks.adaptiveThreshold
      ? computeEffectiveThreshold({
          baseThreshold: config.hooks.denyThreshold,
          sessionSavedTokens: savedThisSession,
          sessionBudgetTokens: config.hooks.adaptiveBudgetTokens ?? 100_000,
          enabled: true,
        })
      : config.hooks.denyThreshold
    const offset = typeof e.offset === 'number' ? e.offset : null
    const limit = typeof e.limit === 'number' ? e.limit : null
    if (spanCannotExceed(offset, limit, threshold)) return next(e)

    const size = typeof fileStat.size === 'number' ? fileStat.size : 0
    const content = size >= FS_READ_MAX ? null : await $.fs.read(filePath).then(String, () => null)
    const lineCount = content === null ? await countLines($, filePath, size) : 0
    if (lineCount === null) return next(e)
    const gate =
      content === null
        ? decideReadGateFromStats({ filePath, lineCount, bytes: size, offset, limit, threshold })
        : decideReadGate({ filePath, content, offset, limit, threshold })
    if (gate.kind === 'pass') return next(e)

    const pointer =
      `[token-pilot] ${filePath} has ${gate.lineCount} lines. Use ${PREFIX}smart_read for its structure, ` +
      `${PREFIX}read_symbol for one symbol, or Read with offset/limit.`
    if (config.hooks.mode === 'advisory') return { deny: pointer }

    // force: the server de-duplicates files it already sent, and would answer
    // a reader that never saw this one with a "previously loaded" reminder.
    let text: string | undefined
    try {
      const outline = await $.tool.call({ tool: `${PREFIX}smart_read`, path: filePath, force: true } as never)
      text = outline.deny === undefined && !outline.isError ? outline.text : undefined
    } catch {
      text = undefined
    }
    if (!text) return { deny: pointer }

    const ran = await next({ ...e, offset: 1, limit: 1 })
    if (ran.deny !== undefined || ran.isError) return ran

    const saved = Math.max(0, gate.estTokens - estimateTokens(text))
    savedThisSession += saved
    try {
      const event = tagEvent({
        ts: Date.now(),
        session_id: await $.session.id(),
        agent_type: null,
        agent_id: e.agentId ?? null,
        event: 'denied',
        file: filePath,
        lines: gate.lineCount,
        estTokens: gate.estTokens,
        summaryTokens: gate.estTokens - saved,
        savedTokens: saved,
      } as HookEvent, {
        TOKEN_PILOT_WORKFLOW_ID: await $.env.get('TOKEN_PILOT_WORKFLOW_ID'),
        CLAUDE_CODE_WORKFLOW_ID: await $.env.get('CLAUDE_CODE_WORKFLOW_ID'),
        LOOM_WORKFLOW_ID: await $.env.get('LOOM_WORKFLOW_ID'),
        LOOM_TASK_ID: await $.env.get('LOOM_TASK_ID'),
      })
      void appendLog(
        (argv, init) => $.process.run(argv, init),
        `${root}/.token-pilot/hook-events.jsonl`,
        JSON.stringify(event),
        ROTATION_THRESHOLD_BYTES,
      )
    } catch {
      /* telemetry must never cost the model its outline */
    }

    const body = outlineHeader(relative(root, filePath), gate.lineCount, gate.estTokens, PREFIX) + text

    // Claude Code de-duplicates a Read of an unchanged file with the range it
    // already served — our own 1-line read, the second time round — and
    // answers "unchanged". The model has only ever seen an outline of this
    // file, never its text, so it gets the outline again.
    if (ran.result?.type !== 'text') {
      const file = { filePath, content: body, numLines: 1, startLine: 1, totalLines: gate.lineCount }
      return { ...ran, result: { type: 'text', file } } as typeof ran
    }

    return { ...ran, result: { ...ran.result, file: { ...ran.result.file, content: body } } }
  }).catch(caught)
}
