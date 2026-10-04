import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'

const base = (on: any, mode?: string) => {
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'TOKEN_PILOT_MODE' ? mode : undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async () => ({ value: true }))
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }))
}

// Same tiers as the command hook: strict refuses, the default mode advises.
test('strict mode denies an Edit of a code file not prepared with read_for_edit', async ($, on) => {
  base(on, 'strict')

  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toContain('read_for_edit')
})

test('the default mode lets it through with advice', async ($, on) => {
  base(on)

  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toBe(undefined)
  expect((res.context ?? []).join('\n')).toContain('read_for_edit')
})

test('allows the Edit once read_for_edit ran for that file', async ($, on) => {
  base(on, 'strict')

  await $.tool.call({ tool: `${P}read_for_edit`, path: 'src/a.ts', symbol: 'f' } as any)
  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toBe(undefined)
  expect(res.context ?? []).toEqual([])
})

test('does not gate a non-code file', async ($, on) => {
  base(on)

  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/README.md', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toBe(undefined)
})

test('a subagent in a worktree can Edit the file it prepared with a relative read_for_edit', async ($, on) => {
  // The subagent asks for src/a.ts; the hook-mcp-path command hook maps it into
  // the worktree the subagent works in, and its Edit targets the worktree file.
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'TOKEN_PILOT_MODE' ? 'strict' : undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async (_$: any, e: any) => ({
    value: ['/repo/.git', '/repo/.worktrees/f/.git', '/repo/.worktrees/f/src/a.ts'].includes(String(e.path ?? e)),
  }))
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }))

  await $.tool.call({ tool: `${P}read_for_edit`, path: 'src/a.ts', symbol: 'f', agentId: 'sub-1' } as any)
  const res: any = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/.worktrees/f/src/a.ts',
    old_string: 'a',
    new_string: 'b',
    agentId: 'sub-1',
  } as any)

  expect(res.deny).toBe(undefined)
})

test('a file the agent just wrote needs no read_for_edit before its Edit', async ($, on) => {
  base(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'export const a = 1\n' } as any)
  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/new.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.context ?? []).toEqual([])
})

test('strict mode does not gate a file outside the project (read_for_edit refuses it)', async ($, on) => {
  base(on, 'strict')

  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toBe(undefined)
})

test('names no environment variable the agent would have to set', async ($, on) => {
  base(on, 'strict')

  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).not.toContain('in the environment')
})
