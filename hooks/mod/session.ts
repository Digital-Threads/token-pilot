/**
 * Session guidance as a system-prompt section. The SessionStart command hook
 * puts it into the first message, and UserPromptSubmit re-sends an anchor on
 * every turn; a `session` section is part of every request instead, built
 * once and kept stable so the prompt cache holds. Replaces hook-session-start,
 * hook-bootstrap and hook-user-prompt.
 *
 * Duplicate hook registrations are a note for the person, not the model:
 * they go out as a toast. Not ported: the subagent-adoption nudge (it reads
 * the whole event log at every start) and the bootstrap notes (a plugin
 * always carries its agents; the MCP server reports a missing ast-index).
 */

import type { EngineInterface, On } from 'claude-code'
import {
  buildReminderMessage,
  countTokenPilotHooks,
  duplicateWarning,
  parseAgentEntry,
  profileBannerNote,
  snapshotLine,
  type AgentEntry,
} from '../../src/hooks/session-context.js'
import { parseProfileEnv } from '../../src/server/tool-profiles.js'
import { join } from '../../src/core/portable-path.js'
import { caught, configFrom, noteTools, PREFIX } from './host.js'

export const SESSION_ACTIONS = ['hook-session-start', 'hook-bootstrap', 'hook-user-prompt']

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
}

async function agentEntries($: EngineInterface, dir: string): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = []
  try {
    for (const entry of await $.fs.list(dir)) {
      const fileName = String((entry as { name: string }).name)
      if (!fileName.startsWith('tp-') || !fileName.endsWith('.md')) continue
      const body = await readText($, join(dir, fileName))
      if (body !== null) entries.push(parseAgentEntry(fileName, body))
    }
  } catch {
    /* no agents dir */
  }

  return entries
}

async function sessionText($: EngineInterface): Promise<string | null> {
  const root = await $.session.root()
  // Literal names: the engine lists the variables a module reads.
  const env = {
    TOKEN_PILOT_DENY_THRESHOLD: await $.env.get('TOKEN_PILOT_DENY_THRESHOLD'),
    TOKEN_PILOT_ADAPTIVE_THRESHOLD: await $.env.get('TOKEN_PILOT_ADAPTIVE_THRESHOLD'),
    TOKEN_PILOT_ADAPTIVE_BUDGET: await $.env.get('TOKEN_PILOT_ADAPTIVE_BUDGET'),
    TOKEN_PILOT_MODE: await $.env.get('TOKEN_PILOT_MODE'),
    TOKEN_PILOT_BYPASS: await $.env.get('TOKEN_PILOT_BYPASS'),
  }
  const config = configFrom(await readText($, join(root, '.token-pilot.json')), env)
  if (!config.sessionStart.enabled || (await $.env.get('TOKEN_PILOT_BYPASS')) === '1') return null

  // Project agents first; home agents fill in names not already present.
  const seen = new Set<string>()
  const agents: AgentEntry[] = []
  for (const dir of [join(root, '.claude', 'agents'), join(await homeDir($), '.claude', 'agents')]) {
    for (const agent of await agentEntries($, dir)) {
      if (seen.has(agent.name)) continue
      seen.add(agent.name)
      agents.push(agent)
    }
  }

  let text =
    profileBannerNote(parseProfileEnv(await $.env.get('TOKEN_PILOT_PROFILE'))) +
    buildReminderMessage(agents, config.sessionStart.maxReminderTokens)

  const snapshot = join(root, '.token-pilot', 'snapshots', 'latest.md')
  const body = await readText($, snapshot)
  if (body !== null) {
    try {
      const { mtimeMs } = await $.fs.stat(snapshot)
      const line = typeof mtimeMs === 'number' ? snapshotLine(body, Math.max(0, Date.now() - mtimeMs)) : null
      if (line) text += `\n\n${line}`
    } catch {
      /* no snapshot age — skip the line */
    }
  }

  return text
}

async function warnDuplicates($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const sources: Array<{ path: string; count: number }> = []

  for (const path of [
    join(await homeDir($), '.claude', 'settings.json'),
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
  ]) {
    const text = await readText($, path)
    if (text === null) continue
    try {
      const count = countTokenPilotHooks(JSON.parse(text))
      if (count > 0) sources.push({ path, count })
    } catch {
      /* malformed settings — not ours to judge */
    }
  }

  const warning = duplicateWarning(sources)
  if (warning) $.ui.toast(warning)
}

// Built once per session: stable text keeps the prompt cache; a /clear starts a new session.
let section: { session: string; text: Promise<string | null> } | null = null
let warned = false

export function registerSession(on: On): void {
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    noteTools(e.tools)
    if (!e.tools.some(tool => tool.startsWith(PREFIX))) return out
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return out

    if (!warned) {
      warned = true
      void warnDuplicates($).catch(() => {})
    }

    const session = await $.session.id()
    if (section?.session !== session) section = { session, text: sessionText($).catch(() => null) }
    const text = await section.text

    return text ? { sections: [...out.sections, { id: 'token-pilot', scope: 'session' as const, text }] } : out
  }).catch(caught)
}
