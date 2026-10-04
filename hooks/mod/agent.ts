/**
 * Agent, in-process: routing before the subagent starts (hook-pre-task).
 *
 * Budget and task telemetry stay on the command hooks: agents run in the
 * background by default, so the Agent result here is only the launch
 * acknowledgement — SubagentStop is what sees the real answer.
 *
 * Workflow runs (TOKEN_PILOT_WORKFLOW_ID and friends) stay on the command
 * hooks too, which attach the workflow budget note; register.ts leaves this
 * action out of the hand-off flag for such sessions.
 */

import type { EngineInterface, On } from 'claude-code'
import { buildAgentIndexFromFiles, type AgentIndex } from '../../src/core/agent-matcher.js'
import { decidePreTask, subagentNeedsToolGuide, subagentToolGuide } from '../../src/hooks/pre-task.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import { join } from '../../src/core/portable-path.js'
import { caught, withContext } from './host.js'

export const AGENT_ACTIONS = ['hook-pre-task']

type AgentFile = { fileName: string; body: string }

async function inWorkflow($: EngineInterface): Promise<boolean> {
  return Boolean(
    (await $.env.get('TOKEN_PILOT_WORKFLOW_ID')) ??
      (await $.env.get('CLAUDE_CODE_WORKFLOW_ID')) ??
      (await $.env.get('LOOM_WORKFLOW_ID')),
  )
}

async function readAgentFiles($: EngineInterface, dir: string): Promise<AgentFile[]> {
  const files: AgentFile[] = []
  try {
    for (const entry of await $.fs.list(dir)) {
      const fileName = String((entry as { name: string }).name)
      if (!fileName.startsWith('tp-') || !fileName.endsWith('.md')) continue
      files.push({ fileName, body: String(await $.fs.read(join(dir, fileName))) })
    }
  } catch {
    /* no agents dir — nothing to route to */
  }

  return files
}

export function registerAgent(on: On): void {
  let files: AgentFile[] | null = null
  let index: AgentIndex | null = null

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)
    if (await inWorkflow($)) return next(e)

    files ??= await readAgentFiles($, join($.plugin.root, 'agents'))
    index ??= buildAgentIndexFromFiles(files)

    const input = {
      tool_name: 'Agent',
      tool_input: { subagent_type: e.subagent_type, description: e.description, prompt: e.prompt },
    }
    const decision = decidePreTask(input, {
      mode: parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE')),
      agentIndex: index,
      force: (await $.env.get('TOKEN_PILOT_FORCE_SUBAGENTS')) === '1',
      agentNamePrefix: 'token-pilot:',
    })
    if (decision.kind === 'deny') return { deny: decision.reason }

    // The tool guide is for the subagent: it goes into its prompt, not into
    // the parent's context after the launch.
    const call =
      subagentNeedsToolGuide(input) && typeof e.prompt === 'string'
        ? { ...e, prompt: `${e.prompt}\n\n${subagentToolGuide()}` }
        : e

    return withContext(await next(call), decision.kind === 'advise' ? [decision.message] : [])
  }).catch(caught)
}
