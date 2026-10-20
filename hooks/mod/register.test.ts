import { test, expect } from 'claude-code/testing'

const sets: Record<string, string | undefined> = {}

const flagAfterStart = async ($: any, on: any, env: Record<string, string> = {}) => {
  on('env.get', async (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', async (_$: any, e: any) => {
    sets[e.name] = e.value
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'session-1' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.stat', async () => ({ value: { size: 10 } }))
  on('classic.SessionStart', async () => ({}))

  await $.classic.SessionStart({ source: 'startup', session_id: 'session-1' })

  return sets.TOKEN_PILOT_MOD
}

test('ties the hand-off to this session, so a nested claude does not inherit it', async ($, on) => {
  await flagAfterStart($, on)

  expect(sets.TOKEN_PILOT_MOD_SESSION).toBe('session-1')
})

test('keeps the sessions it served before, so their background agents still hand off after /clear', async ($, on) => {
  await flagAfterStart($, on, { TOKEN_PILOT_MOD_SESSION: 'session-0' })

  expect(sets.TOKEN_PILOT_MOD_SESSION).toBe('session-1,session-0')
})

test('keeps that list short and free of repeats', async ($, on) => {
  const older = Array.from({ length: 12 }, (_, i) => `old-${i}`)
  await flagAfterStart($, on, { TOKEN_PILOT_MOD_SESSION: ['session-1', ...older].join(',') })

  expect(sets.TOKEN_PILOT_MOD_SESSION).toBe(['session-1', ...older.slice(0, 7)].join(','))
})

test('on /resume, lists the resumed session from the payload, not the one being left', async ($, on) => {
  on('env.get', async () => ({ value: undefined }))
  on('env.set', async (_$: any, e: any) => {
    sets[e.name] = e.value
    return { value: undefined }
  })
  // $.session.id() still answers the session being left while SessionStart runs.
  on('session.id', async () => ({ value: 'session-left' }))
  on('classic.SessionStart', async () => ({}))

  await ($ as any).classic.SessionStart({ source: 'resume', session_id: 'session-resumed' })

  expect(sets.TOKEN_PILOT_MOD_SESSION).toBe('session-resumed')
})

test('hands the served command hooks off before they run', async ($, on) => {
  const flag = await flagAfterStart($, on)

  expect(flag).toContain('hook-pre-bash')
  expect(flag).toContain('hook-pre-task')
  // Agents run in the background by default: only SubagentStop sees the real
  // answer, so budget and task telemetry stay on the command hooks.
  expect(flag).not.toContain('hook-subagent-stop')
  expect(flag).not.toContain('hook-post-task')
})

test('leaves agent routing to the command hooks in a workflow run', async ($, on) => {
  const flag = await flagAfterStart($, on, { TOKEN_PILOT_WORKFLOW_ID: 'wf-1' })

  expect(flag).toContain('hook-pre-bash')
  expect(flag).not.toContain('hook-pre-task')
})

// Where an outer plugin (Claude Code's sec-default) passes classic.SessionStart
// on past this one, no classic.SessionStart is raised here at all.
const withoutSessionStart = (on: any, id: { current: string }) => {
  const env: Record<string, string> = {}
  const listings: string[] = []

  on('env.get', async (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', async (_$: any, e: any) => {
    env[e.name] = e.value
    if (e.name === 'TOKEN_PILOT_MOD_SESSION') listings.push(e.value)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: id.current }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('session.start', async () => ({ cwd: '/repo' }))

  return { env, listings }
}

const COMMAND = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }

test('lists the new session once /clear or /resume returns, with no classic.SessionStart', async ($, on) => {
  const id = { current: 'session-1' }
  const { env, listings } = withoutSessionStart(on, id)
  // The session switches inside the command, as /clear and /resume do.
  on('command.run', async (_$: any, e: any) => {
    if (e.command === 'clear') id.current = 'session-2'
    if (e.command === 'resume') id.current = 'session-1'
    return { text: '' }
  })

  await ($ as any).session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($ as any).command.run({ ...COMMAND, command: 'clear' })

  expect(env.TOKEN_PILOT_MOD_SESSION).toBe('session-2,session-1')
  expect(env.TOKEN_PILOT_MOD).toContain('hook-pre-bash')

  // Back to a session already listed: nothing to write.
  await ($ as any).command.run({ ...COMMAND, command: 'resume' })
  await ($ as any).command.run({ ...COMMAND, command: 'model' })

  expect(listings).toEqual(['session-1', 'session-2,session-1'])
})

test('lists the session before a prompt reaches the command hooks, however it changed', async ($, on) => {
  const id = { current: 'session-1' }
  const { env, listings } = withoutSessionStart(on, id)
  let seenByCommandHooks: string | undefined
  on('prompt.submit', async (_$: any, e: any) => {
    seenByCommandHooks = env.TOKEN_PILOT_MOD_SESSION
    return { text: e.text }
  })

  await ($ as any).session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  id.current = 'session-2'
  await ($ as any).prompt.submit({ text: 'hi' })
  await ($ as any).prompt.submit({ text: 'again' })

  expect(seenByCommandHooks).toBe('session-2,session-1')
  expect(listings).toEqual(['session-1', 'session-2,session-1'])
})

// What the UserPromptSubmit command hooks see in TOKEN_PILOT_MOD on each prompt.
const promptsSeeing = (on: any, env: Record<string, string>) => {
  const seen: string[] = []
  on('prompt.submit', async (_$: any, e: any) => {
    seen.push(env.TOKEN_PILOT_MOD ?? '')
    return { text: e.text }
  })
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))

  return seen
}

const GUIDANCE = ['hook-session-start', 'hook-bootstrap', 'hook-user-prompt']

test('when prompt.compose is passed over, the command hooks keep the guidance from the next prompt on', async ($, on) => {
  const { env } = withoutSessionStart(on, { current: 'session-1' })
  const seen = promptsSeeing(on, env)

  await ($ as any).session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($ as any).prompt.submit({ text: 'one' })
  // The turn starts, and no prompt.compose reaches this plugin.
  await ($ as any).turn.start({ text: 'one', turnId: 't1' })
  await ($ as any).prompt.submit({ text: 'two' })

  for (const action of GUIDANCE) expect(seen[0]).toContain(action)
  for (const action of GUIDANCE) expect(seen[1].split(',')).not.toContain(action)
  expect(seen[1]).toContain('hook-pre-bash')
})

test('where prompt.compose runs, the guidance stays with it and the command hooks stay aside', async ($, on) => {
  const { env, listings } = withoutSessionStart(on, { current: 'session-1' })
  const seen = promptsSeeing(on, env)
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async () => ({ deny: 'no such file' }))
  on('fs.list', async () => ({ value: [] }))
  on('prompt.compose', async () => ({ sections: [] }))

  await ($ as any).session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($ as any).turn.start({ text: 'one', turnId: 't1' })
  await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: [] })
  await ($ as any).prompt.submit({ text: 'two' })

  for (const action of GUIDANCE) expect(seen[0]).toContain(action)
  expect(listings).toEqual(['session-1'])
})

test('TOKEN_PILOT_NO_MOD=1 hands nothing off, so every command hook runs', async ($, on) => {
  const flag = await flagAfterStart($, on, { TOKEN_PILOT_NO_MOD: '1' })

  expect(flag).toBe('')
})
