import { test, expect } from 'claude-code/testing'

const stubs = (on: any) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
}

test('denies cat on a code file before Bash runs', async ($, on) => {
  stubs(on)
  let ran = false
  on('tool.call', { tool: 'Bash' }, () => {
    ran = true
    return { result: { stdout: '', stderr: '' } } as any
  })

  const res: any = await $.tool.call({ tool: 'Bash', command: 'cat src/index.ts' } as any)

  expect(res.deny).toContain('`cat` on a code file')
  expect(ran).toBe(false)
})

test('adds advice after a very large output', async ($, on) => {
  stubs(on)
  const big = 'x\n'.repeat(9000)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: big, stderr: '' }, text: big }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'make' } as any)

  expect(res.deny).toBe(undefined)
  expect((res.context ?? []).join('\n')).toMatch(/output was large/)
})

test('a plain command passes untouched', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok' }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'echo ok' } as any)

  expect(res.deny).toBe(undefined)
  expect(res.context ?? []).toEqual([])
})

test('TOKEN_PILOT_NO_MOD=1 leaves Bash to the command hook', async ($, on) => {
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'TOKEN_PILOT_NO_MOD' ? '1' : undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' }, text: '' }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'cat src/index.ts' } as any)

  expect(res.deny).toBe(undefined)
})

test('a denied command is logged by its reason, never its text, and tagged for Loom', async ($, on) => {
  const logged: string[] = []
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'LOOM_TASK_ID' ? 'task-7' : undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('process.run', async (_$: any, e: any) => {
    logged.push(JSON.stringify(e))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }) as any)

  await $.tool.call({ tool: 'Bash', command: 'cat src/keys-sk-live-SECRET123.ts' } as any)
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(logged.join('\n')).not.toContain('SECRET123')
  expect(logged.join('\n')).toContain('bash_denied')
  expect(logged.join('\n')).toContain('task-7')
})

test('a hook that throws is logged to hook-errors.jsonl and the call goes ahead', async ($, on) => {
  const logged: string[] = []
  on('env.get', async (_$: any, e: any) =>
    e.name === 'TOKEN_PILOT_MODE' ? { deny: 'env unreadable' } : { value: e.name === 'HOME' ? '/home/u' : undefined },
  )
  on('session.root', async () => ({ value: '/repo' }))
  on('process.run', async (_$: any, e: any) => {
    logged.push(JSON.stringify(e))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok' }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'cat src/index.ts' } as any)
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(res.deny).toBe(undefined)
  expect(logged.join('\n')).toContain('/home/u/.token-pilot/hook-errors.jsonl')
  expect(logged.join('\n')).toContain('mod:Bash')
  expect(logged.join('\n')).toContain('mod_hook_failed')
  // The engine hands the handler { kind, message }, not an Error.
  expect(logged.join('\n')).toContain('env unreadable')
  expect(logged.join('\n')).not.toContain('[object Object]')
})

test('without sh, a log line is appended through node, never by rewriting the file', async ($, on) => {
  const runs: any[] = []
  on('env.get', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('process.run', async (_$: any, e: any) => {
    runs.push(e)
    return e.argv[0] === 'sh'
      ? { deny: 'sh: not found' }
      : { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }) as any)

  await $.tool.call({ tool: 'Bash', command: 'cat src/index.ts' } as any)
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(runs.map(r => r.argv[0])).toEqual(['sh', 'node'])
  expect(runs[1].argv).toContain('/repo/.token-pilot/hook-events.jsonl')
  expect(runs[1].init.stdin).toContain('bash_denied')
})

test('after a large output, points at the context-mode tool the session has', async ($, on) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async () => ({ deny: 'no such file' }))
  on('fs.stat', async () => ({ deny: 'no such file' }))
  on('fs.list', async () => ({ value: [] }))
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.compose', async () => ({ sections: [] }))
  const big = 'x\n'.repeat(9000)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: big, stderr: '' }, text: big }) as any)

  await ($ as any).prompt.compose({
    model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [],
    tools: ['Bash', 'mcp__plugin_context-mode_context-mode__ctx_execute'],
  })
  const res: any = await $.tool.call({ tool: 'Bash', command: 'make' } as any)

  expect((res.context ?? []).join('\n')).toContain('mcp__plugin_context-mode_context-mode__ctx_execute')
})

test('TOKEN_PILOT_BYPASS=1 in the env lets a dump through', async ($, on) => {
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'TOKEN_PILOT_BYPASS' ? '1' : undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' }, text: '' }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'cat src/index.ts' } as any)

  expect(res.deny).toBe(undefined)
})

test('a TOKEN_PILOT_BYPASS=1 prefix lets a dump through', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' }, text: '' }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'TOKEN_PILOT_BYPASS=1 cat src/index.ts' } as any)

  expect(res.deny).toBe(undefined)
})

test('find inside the session root passes; outside it is a disk walk', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' }, text: '' }) as any)

  const inside: any = await $.tool.call({ tool: 'Bash', command: 'find /repo/src -type f' } as any)
  const outside: any = await $.tool.call({ tool: 'Bash', command: 'find /opt -type f' } as any)

  expect(inside.deny).toBe(undefined)
  expect(outside.deny).toContain('find /opt')
})
