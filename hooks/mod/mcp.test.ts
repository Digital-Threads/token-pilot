import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'

const repo = (on: any, cwd: string, gitDirs: string[]) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.cwd', async () => ({ value: cwd }))
  on('fs.exists', async (_$: any, e: any) => ({ value: gitDirs.includes(String(e.path ?? e)) }))
}

test('resolves a relative path against the worktree the session moved into', async ($, on) => {
  repo(on, '/repo/.worktrees/f/src', ['/repo/.git', '/repo/.worktrees/f/.git'])
  let seen: any
  on('tool.call', async (_$: any, e: any) => {
    seen = e
    return { result: 'ok', text: 'ok' } as any
  })

  await $.tool.call({ tool: `${P}smart_read`, path: 'src/a.ts' } as any)

  expect(seen.path).toBe('/repo/.worktrees/f/src/a.ts')
})

test('leaves calls in the server checkout untouched', async ($, on) => {
  repo(on, '/repo/src', ['/repo/.git'])
  let seen: any
  on('tool.call', async (_$: any, e: any) => {
    seen = e
    return { result: 'ok', text: 'ok' } as any
  })

  await $.tool.call({ tool: `${P}smart_read`, path: 'src/a.ts' } as any)

  expect(seen.path).toBe('src/a.ts')
})

test('leaves a subagent call to the command hook, which reads the subagent cwd', async ($, on) => {
  repo(on, '/repo/.worktrees/f/src', ['/repo/.git', '/repo/.worktrees/f/.git'])
  let seen: any
  on('tool.call', async (_$: any, e: any) => {
    seen = e
    return { result: 'ok', text: 'ok' } as any
  })

  await $.tool.call({ tool: `${P}smart_read`, path: 'src/a.ts', agentId: 'sub-1' } as any)

  expect(seen.path).toBe('src/a.ts')
})
