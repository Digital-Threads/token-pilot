/**
 * The savings line as a band above the prompt input: one line, drawn by the
 * mod, in place of a second copy beside the user's `statusLine`. The numbers
 * come from hooks/tp-statusline.sh — the single savings calculator — run
 * after each main-loop turn, when they can have changed, and when /clear or
 * /resume starts another session.
 *
 * That script prints nothing in a statusLine for a session the mod serves
 * (TOKEN_PILOT_MOD / TOKEN_PILOT_MOD_SESSION), so the line shows once. Not
 * drawn at session start: Claude Code runs the statusLine once before the
 * session's hooks hand those variables off, and again only when the session
 * changes (a reply, the mode, the model). Until the first reply that run's
 * line is the one shown; a band drawn earlier would sit beside it.
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { caught } from './host.js'

// tp-statusline.sh colours with bash $'\033[…' quoting — run it with bash, then strip.
const ANSI = /\u001b\[[0-9;]*m/g

const line = atom({ plugin: 'token-pilot', key: 'band' } as const, null)

async function refresh($: EngineInterface, session: string): Promise<void> {
  if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return

  // The statusLine payload's shape, which the script parses.
  const { rateLimits } = await $.session.usage()
  const payload = JSON.stringify({
    session_id: session,
    cwd: await $.session.cwd(),
    rate_limits: Object.fromEntries(rateLimits.map(limit => [limit.kind, { used_percentage: limit.percentUsed }])),
  })
  // An empty TOKEN_PILOT_MOD lets the script print for this call: its silence is for the statusLine.
  const run = await $.process.run(['bash', `${$.plugin.root}/hooks/tp-statusline.sh`], {
    stdin: payload,
    env: { TOKEN_PILOT_MOD: '' },
  })
  const text = (run.stdout.split('\n')[0] ?? '').replace(ANSI, '').trim()

  // The write redraws the band.
  await update($, line, () => text || null)
}

export function registerBand(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    // A reload or an update of the plugin keeps the pin 1.0.3 and earlier set.
    $.ui.status(undefined)

    return next(e)
  }).catch(caught)

  // Past the first startup the statusLine has gone quiet already: redraw the
  // line for the new session at once, or the band keeps the last one's figures.
  // The payload's session_id: $.session.id() still answers the session being left.
  on('classic.SessionStart', { source: ['clear', 'resume', 'compact', 'fork'] }, async ($, e, next) => {
    const done = await next(e)
    await refresh($, e.session_id).catch(() => {})

    return done
  }).catch(caught)

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await refresh($, await $.session.id()).catch(() => {})

    return done
  }).catch(caught)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    if (text === null || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box width={e.props.bodyColumns}>
        <Text dimColor wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
  }).catch(caught)
}
