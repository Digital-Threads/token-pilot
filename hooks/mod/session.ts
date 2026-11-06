/**
 * Session start, in-process. The model gets a `session` section only when a
 * fresh snapshot is there to resume from: each tool's own description says
 * when to use it, so no rule block or agent list goes into the prompt.
 * Replaces hook-session-start and hook-bootstrap.
 *
 * What the person has to fix — a hook registered twice, old agent copies
 * that shadow the plugin's — goes out as a toast, never to the model.
 */

import type { EngineInterface, On } from 'claude-code'
import {
  countTokenPilotHooks,
  duplicateWarning,
  isLegacyAgent,
  legacyAgentsWarning,
  snapshotLine,
} from '../../src/hooks/session-context.js'
import { join } from '../../src/core/portable-path.js'
import { caught, configFrom, noteTools, PREFIX } from './host.js'

export const SESSION_ACTIONS = ['hook-session-start', 'hook-bootstrap']

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

  const snapshot = join(root, '.token-pilot', 'snapshots', 'latest.md')
  const body = await readText($, snapshot)
  if (body === null) return null

  try {
    const { mtimeMs } = await $.fs.stat(snapshot)

    return typeof mtimeMs === 'number' ? snapshotLine(body, Math.max(0, Date.now() - mtimeMs)) : null
  } catch {
    return null // no snapshot age — skip the line
  }
}

/** tp-*.md files in `dir` that list only the npm server's tool names. */
async function countLegacyAgents($: EngineInterface, dir: string): Promise<number> {
  let count = 0
  try {
    for (const entry of await $.fs.list(dir)) {
      const name = String((entry as { name: string }).name)
      if (!name.startsWith('tp-') || !name.endsWith('.md')) continue
      const body = await readText($, join(dir, name))
      if (body !== null && isLegacyAgent(body)) count++
    }
  } catch {
    /* no agents dir */
  }

  return count
}

async function warnPerson($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const home = await homeDir($)
  const sources: Array<{ path: string; count: number }> = []

  for (const path of [
    join(home, '.claude', 'settings.json'),
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

  // Claude Code reads user agents from its config dir.
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const userDir = configDir ? join(configDir, 'agents') : join(home, '.claude', 'agents')
  const projectDir = join(root, '.claude', 'agents')

  for (const note of [
    duplicateWarning(sources),
    legacyAgentsWarning([
      { dir: userDir, count: await countLegacyAgents($, userDir), scope: 'user' },
      { dir: projectDir, count: await countLegacyAgents($, projectDir), scope: 'project' },
    ]),
  ]) {
    if (note) $.ui.toast(note)
  }
}

// Built once per session: stable text keeps the prompt cache; a /clear starts a new session.
let section: { session: string; text: Promise<string | null> } | null = null
let warnedSession: string | null = null

// prompt.compose runs as each main-loop turn starts, unless an outer plugin
// passes it on past this one (Claude Code's sec-default does, for Team and
// Enterprise organizations). No signal says so: a turn that started without
// it does. Then the command hooks keep session start (register.ts hands
// SESSION_ACTIONS back to them).
let composed = false
let turnStarted = false

export const composePassedOver = (): boolean => turnStarted && !composed

export function registerSession(on: On): void {
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turnStarted = true

    return next(e)
  }).catch(caught)

  on('prompt.compose', async ($, e, next) => {
    composed = true
    const out = await next(e)
    noteTools(e.tools)
    if (!e.tools.some(tool => tool.startsWith(PREFIX))) return out
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return out

    const session = await $.session.id()
    if (warnedSession !== session) {
      warnedSession = session
      void warnPerson($).catch(() => {})
    }

    if (section?.session !== session) section = { session, text: sessionText($).catch(() => null) }
    const text = await section.text

    return text ? { sections: [...out.sections, { id: 'token-pilot', scope: 'session' as const, text }] } : out
  }).catch(caught)
}
