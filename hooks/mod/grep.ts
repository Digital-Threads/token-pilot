/**
 * Grep, in-process: a symbol-like pattern goes to find_usages, a TODO scan
 * gets a pointer to code_audit. Replaces the hook-pre-grep command hook.
 */

import type { On } from 'claude-code'
import { decidePreGrep } from '../../src/hooks/pre-grep.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import { caught, withContext } from './host.js'

export const GREP_ACTIONS = ['hook-pre-grep']

export function registerGrep(on: On): void {
  // Claude Code 2.1.289 has no Grep tool (search goes through Bash, which
  // bash.ts gates). A pattern, not the name, keeps this hook for the builds
  // that still have one without naming a tool this build's types lack.
  on('tool.call', { tool: /^Grep$/ }, async ($, e, next) => {
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)

    const mode = parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE'))
    const decision = decidePreGrep({ tool_name: 'Grep', tool_input: { ...e } } as never, mode)
    if (decision.kind === 'deny') return { deny: decision.reason }

    return withContext(await next(e), decision.kind === 'advise' ? [decision.reason] : [])
  }).catch(caught)
}
