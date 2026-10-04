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

test('TOKEN_PILOT_NO_MOD=1 hands nothing off, so every command hook runs', async ($, on) => {
  const flag = await flagAfterStart($, on, { TOKEN_PILOT_NO_MOD: '1' })

  expect(flag).toBe('')
})
