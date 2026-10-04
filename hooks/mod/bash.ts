/**
 * Bash, in-process: the pre-check (deny `cat` on code, recursive grep,
 * unbounded git log/diff) and the post-advice after a large output, in one
 * hook. Replaces the hook-pre-bash and hook-post-bash command hooks.
 */

import type { On } from 'claude-code'
import { decidePreBash } from '../../src/hooks/pre-bash.js'
import { decidePostBashAdvice } from '../../src/hooks/post-bash.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import { diagnosticEvent, ROTATION_THRESHOLD_BYTES, tagEvent } from '../../src/core/hook-event.js'
import { appendLog, caught, contextModeToolName, withContext } from './host.js'

export const BASH_ACTIONS = ['hook-pre-bash', 'hook-post-bash']

export function registerBash(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)

    const command = String(e.command ?? '')
    const mode = parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE'))
    const decision = decidePreBash({ tool_name: 'Bash', tool_input: { command } }, mode, {
      bypass: (await $.env.get('TOKEN_PILOT_BYPASS')) === '1',
      projectRoot: await $.session.root(),
    })

    if (decision.kind === 'deny') {
      // The reason, never the command: a command line can carry secrets.
      const event = tagEvent(diagnosticEvent({ code: 'bash_denied', detail: { reason: decision.reason.slice(0, 80) } }, Date.now()), {
        TOKEN_PILOT_WORKFLOW_ID: await $.env.get('TOKEN_PILOT_WORKFLOW_ID'),
        CLAUDE_CODE_WORKFLOW_ID: await $.env.get('CLAUDE_CODE_WORKFLOW_ID'),
        LOOM_WORKFLOW_ID: await $.env.get('LOOM_WORKFLOW_ID'),
        LOOM_TASK_ID: await $.env.get('LOOM_TASK_ID'),
      })
      void appendLog(
        (argv, init) => $.process.run(argv, init),
        `${await $.session.root()}/.token-pilot/hook-events.jsonl`,
        JSON.stringify(event),
        ROTATION_THRESHOLD_BYTES,
      )

      return { deny: decision.reason }
    }

    const ran = await next(e)
    const contextModeTool = contextModeToolName()
    const advice = decidePostBashAdvice(
      { tool_name: 'Bash', tool_response: { stdout: ran.text ?? '' } },
      { contextModeAvailable: contextModeTool !== undefined, contextModeTool },
    )

    return withContext(ran, [
      ...(decision.kind === 'advise' ? [decision.reason] : []),
      ...(advice.additionalContext ? [advice.additionalContext] : []),
    ])
  }).catch(caught)
}
