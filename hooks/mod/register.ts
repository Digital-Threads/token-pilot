/**
 * token-pilot as a Claude Code mod: its hooks run inside Claude Code (2.1.275+)
 * instead of as one process per tool call. The command hooks in
 * hooks/hooks.json stay for older Claude Code, for sessions where mods are
 * off, and for any action this mod does not serve yet.
 *
 * Engine rule: one unmatched hook per event per module, so every unmatched
 * hook lives here and delegates.
 */

import type { EngineInterface, Register } from 'claude-code'
import { setPluginInstall } from '../../src/core/tool-names.js'
import { caught } from './host.js'
import { BASH_ACTIONS, registerBash } from './bash.js'
import { GREP_ACTIONS, registerGrep } from './grep.js'
import { MCP_ACTIONS, createEditPrep, registerMcp } from './mcp.js'
import { EDIT_ACTIONS, registerEdit } from './edit.js'
import { READ_ACTIONS, registerRead } from './read.js'
import { AGENT_ACTIONS, registerAgent } from './agent.js'
import { SESSION_ACTIONS, registerSession } from './session.js'
import { registerStatus } from './status.js'
import { STATS_COMMAND, registerStats } from './stats.js'

/**
 * Command-hook actions this mod handles in-process. hooks/run.sh exits early
 * for each one, so no call is handled twice. With the mod off, nothing is
 * set and every command hook runs as before.
 */
const SERVED: string[] = [...BASH_ACTIONS, ...GREP_ACTIONS, ...MCP_ACTIONS, ...EDIT_ACTIONS, ...READ_ACTIONS, ...SESSION_ACTIONS]

const MAX_SESSIONS = 8

async function handOff($: EngineInterface, id: string): Promise<void> {
  // Workflow runs keep agent routing on the command hooks, which attach the
  // workflow budget note (see agent.ts).
  const inWorkflow = Boolean(
    (await $.env.get('TOKEN_PILOT_WORKFLOW_ID')) ??
      (await $.env.get('CLAUDE_CODE_WORKFLOW_ID')) ??
      (await $.env.get('LOOM_WORKFLOW_ID')),
  )
  const served = inWorkflow ? SERVED : [...SERVED, ...AGENT_ACTIONS]
  // Escape hatch: TOKEN_PILOT_NO_MOD=1 keeps every hook on the command path
  // (the handlers check it too), exactly as on a Claude Code without mods.
  const noMod = (await $.env.get('TOKEN_PILOT_NO_MOD')) === '1'

  await $.env.set('TOKEN_PILOT_MOD', noMod ? '' : served.join(','))

  // A nested claude inherits both; run.sh only steps aside for the sessions
  // listed here. Earlier ones stay: after /clear their background agents run on.
  const earlier = ((await $.env.get('TOKEN_PILOT_MOD_SESSION')) ?? '').split(',').filter(s => s && s !== id)
  await $.env.set('TOKEN_PILOT_MOD_SESSION', [id, ...earlier].slice(0, MAX_SESSIONS).join(','))
}

export const register: Register = on => {
  setPluginInstall(true)

  // Mod hooks run before the command hooks, so the flag set here is already
  // visible to the command SessionStart of this same session.
  // The payload's session_id, not $.session.id(): on /resume that still
  // answers the session being left, while the command hooks get the new one.
  on('classic.SessionStart', async ($, e, next) => {
    await handOff($, e.session_id)
    return next(e)
  }).catch(caught)

  // Again on a hot reload, where classic.SessionStart does not fire.
  on('session.start', async ($, e, next) => {
    await handOff($, await $.session.id())
    await $.command.register(STATS_COMMAND)
    return next(e)
  }).catch(caught)

  registerBash(on)
  registerGrep(on)

  const prep = createEditPrep()
  registerMcp(on, prep)
  registerEdit(on, prep)
  registerRead(on)
  registerAgent(on)
  registerSession(on)
  registerStatus(on)
  registerStats(on)
}
