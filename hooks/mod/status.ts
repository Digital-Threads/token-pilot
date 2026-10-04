/**
 * The savings line in Claude Code's status area. `$.ui.status` adds a line of
 * its own beside the user's `statusLine`, so it never takes that one slot.
 * The numbers come from hooks/tp-statusline.sh — the single savings
 * calculator — run after each main-loop turn, when they can have changed.
 * Users whose statusLine already runs that script see only their own line.
 */

import type { EngineInterface, On } from 'claude-code'
import { caught } from './host.js'

// tp-statusline.sh colours with bash $'\033[…' quoting — run it with bash, then strip.
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Whether the statusLine Claude Code runs — the engine's merge of user,
 * project, local, --settings and managed settings — already shows
 * token-pilot's savings.
 */
export function statusLineShowsSavings(settings: Readonly<Record<string, unknown>>): boolean {
  const command = (settings.statusLine as { command?: unknown } | undefined)?.command

  return /tp-statusline|statusline-chain/.test(String(command ?? ''))
}

async function refresh($: EngineInterface): Promise<void> {
  const payload = JSON.stringify({ session_id: await $.session.id(), cwd: await $.session.cwd() })
  const run = await $.process.run(['bash', `${$.plugin.root}/hooks/tp-statusline.sh`], { stdin: payload })
  const line = (run.stdout.split('\n')[0] ?? '').replace(ANSI, '').trim()

  $.ui.status(line || undefined)
}

export function registerStatus(on: On): void {
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    // Read every turn: one call, and /statusline can change it mid-session.
    if (!statusLineShowsSavings(await $.settings.read())) await refresh($).catch(() => {})

    return done
  }).catch(caught)
}
