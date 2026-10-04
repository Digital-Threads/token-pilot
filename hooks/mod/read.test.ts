import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'
const BIG = 'const x = 1;\n'.repeat(800)

const base = (on: any, content = BIG, override: Record<string, (...args: any[]) => unknown> = {}) => {
  const stubs: Record<string, (...args: any[]) => unknown> = {
    'env.get': async () => ({ value: undefined }),
    'session.root': async () => ({ value: '/repo' }),
    'session.id': async () => ({ value: 's1' }),
    'fs.read': async () => ({ value: content }),
    'fs.stat': async (_$: any, e: any) => ({ value: { realPath: e.path, size: content.length } }),
    'process.run': async () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }),
    ...override,
  }
  for (const [event, stub] of Object.entries(stubs)) on(event, stub)
}

const readResult = (filePath: string, content: string) => ({
  result: { type: 'text', file: { filePath, content, numLines: 1, startLine: 1, totalLines: 801 } },
})

test('a whole-file Read of a big code file comes back as the outline', async ($, on) => {
  base(on)
  on('tool.call', async (_$: any, e: any) =>
    e.tool === `${P}smart_read`
      ? ({ result: 'OUTLINE', text: 'FILE: src/a.ts\nfunction f() [L1-2]' } as any)
      : (readResult(e.file_path, 'const x = 1;') as any),
  )

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.result.file.content).toContain('not the file text')
  expect(res.result.file.content).toContain('function f()')
})

test('a bounded Read under the threshold passes untouched', async ($, on) => {
  base(on)
  on('tool.call', async (_$: any, e: any) => readResult(e.file_path, 'RAW') as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', offset: 10, limit: 20 } as any)

  expect(res.result.file.content).toBe('RAW')
})

test('a file outside the project passes untouched', async ($, on) => {
  base(on)
  on('tool.call', async (_$: any, e: any) => readResult(e.file_path, 'RAW') as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/elsewhere/a.ts' } as any)

  expect(res.result.file.content).toBe('RAW')
})

test('a non-code file passes untouched', async ($, on) => {
  base(on)
  on('tool.call', async (_$: any, e: any) => readResult(e.file_path, 'RAW') as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/notes.md' } as any)

  expect(res.result.file.content).toBe('RAW')
})

test('when smart_read fails, the model gets a pointer, not silence', async ($, on) => {
  base(on)
  on('tool.call', async (_$: any, e: any) =>
    e.tool === `${P}smart_read` ? ({ deny: 'no server' } as any) : (readResult(e.file_path, 'RAW') as any),
  )

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.deny).toContain('smart_read')
})

test('asks smart_read for the outline even when the server already sent this file', async ($, on) => {
  base(on)
  // The server de-duplicates: without force it answers with a short reminder
  // that this file was loaded before — useless to a reader that never saw it.
  on('tool.call', async (_$: any, e: any) =>
    e.tool === `${P}smart_read`
      ? ({ result: 'x', text: e.force === true ? 'FILE: src/a.ts\nfunction f() [L1-2]' : 'REMINDER: src/a.ts previously loaded, unchanged' } as any)
      : (readResult(e.file_path, 'const x = 1;') as any),
  )

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.result.file.content).toContain('function f()')
  expect(res.result.file.content).not.toContain('REMINDER')
})

test('a bounded Read within the threshold never reads the file', async ($, on) => {
  let reads = 0
  base(on, BIG, {
    'fs.read': async (_$: any, e: any) => {
      if (String(e.path ?? e).endsWith('/src/a.ts')) reads++
      return { value: BIG }
    },
  })
  on('tool.call', async (_$: any, e: any) => readResult(e.file_path, 'RAW') as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', offset: 10, limit: 20 } as any)

  expect(res.result.file.content).toBe('RAW')
  expect(reads).toBe(0)
})

test('a file over the 4 MiB read limit is still gated, by its line count', async ($, on) => {
  base(on, BIG, {
    'fs.stat': async (_$: any, e: any) => ({ value: { realPath: e.path, size: 6 * 1024 * 1024 } }),
    'fs.read': async () => ({ deny: 'over 4 MiB' }),
    'process.run': async (_$: any, e: any) => ({
      value: {
        exitCode: 0,
        stdout: e.argv?.[0] === 'wc' ? '250000 /repo/src/huge.ts\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }),
  })
  on('tool.call', async (_$: any, e: any) =>
    e.tool === `${P}smart_read`
      ? ({ result: 'x', text: 'FILE: src/huge.ts\nfunction f() [L1-2]' } as any)
      : (readResult(e.file_path, 'line 1') as any),
  )

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' } as any)

  expect(res.result.file.content).toContain('has 250000 lines')
  expect(res.result.file.content).toContain('function f()')
})

test('when the smart_read call itself fails, the model still gets the pointer', async ($, on) => {
  base(on)
  on('tool.call', async (_$: any, e: any) => {
    if (e.tool === `${P}smart_read`) throw new Error('server gone')
    return readResult(e.file_path, 'RAW') as any
  })

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.deny).toContain('smart_read')
})

const wcRun = (runs: any[] = []) => async (_$: any, e: any) => {
  runs.push(e)
  return {
    value: {
      exitCode: 0,
      stdout: e.argv?.[0] === 'wc' ? '250000 /repo/src/huge.ts\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }
}

const outlineOrLine = async (_$: any, e: any) =>
  e.tool === `${P}smart_read`
    ? ({ result: 'x', text: 'FILE: src/huge.ts\nfunction f() [L1-2]' } as any)
    : (readResult(e.file_path, 'line 1') as any)

test('a missing file goes to Read untouched and is not logged as a hook error', async ($, on) => {
  const runs: any[] = []
  base(on, BIG, {
    'env.get': async (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }),
    'fs.stat': async (_$: any, e: any) =>
      e.path === '/repo' ? { value: { realPath: '/repo', size: 0 } } : { deny: 'ENOENT: no such file' },
    'process.run': wcRun(runs),
  })
  on('tool.call', async () => ({ result: 'File does not exist.', isError: true, text: 'File does not exist.' }) as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/missing.ts' } as any)
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(res.text).toBe('File does not exist.')
  expect(JSON.stringify(runs)).not.toContain('hook-errors')
})

test('a file of exactly 4 MiB is measured with wc, not read', async ($, on) => {
  let reads = 0
  base(on, BIG, {
    'fs.stat': async (_$: any, e: any) => ({ value: { realPath: e.path, size: 4 * 1024 * 1024 } }),
    'fs.read': async (_$: any, e: any) => {
      if (String(e.path ?? e).endsWith('/src/huge.ts')) reads++
      return { value: BIG }
    },
    'process.run': wcRun(),
  })
  on('tool.call', outlineOrLine)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' } as any)

  expect(reads).toBe(0)
  expect(res.result.file.content).toContain('has 250000 lines')
})

test('a file the engine refuses to read is still gated, by its line count', async ($, on) => {
  base(on, BIG, {
    'fs.read': async (_$: any, e: any) =>
      String(e.path ?? e).endsWith('/src/huge.ts') ? { deny: 'refused' } : { deny: 'no such file' },
    'process.run': wcRun(),
  })
  on('tool.call', outlineOrLine)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/huge.ts' } as any)

  expect(res.result.file.content).toContain('has 250000 lines')
})

test('a file nobody may read goes to Read untouched, not to a guessed line count', async ($, on) => {
  base(on, BIG, {
    // 40 KB: estimated at 1000 lines, over the threshold, if wc's failure were ignored.
    'fs.stat': async (_$: any, e: any) => ({ value: { realPath: e.path, size: 40_000 } }),
    'fs.read': async (_$: any, e: any) =>
      String(e.path ?? e).endsWith('/src/locked.ts') ? { deny: 'EACCES: permission denied' } : { deny: 'no such file' },
    'process.run': async (_$: any, e: any) => ({
      value: {
        exitCode: e.argv?.[0] === 'wc' ? 1 : 0,
        stdout: '',
        stderr: e.argv?.[0] === 'wc' ? 'wc: /repo/src/locked.ts: Permission denied\n' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }),
  })
  on('tool.call', async (_$: any, e: any) =>
    // smart_read cannot read it either.
    e.tool === `${P}smart_read`
      ? ({ result: 'EACCES', isError: true, text: 'EACCES: permission denied' } as any)
      : ({ result: 'EACCES: permission denied', isError: true, text: 'EACCES: permission denied' } as any),
  )

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/locked.ts' } as any)

  expect(res.deny).toBe(undefined)
  expect(res.text).toBe('EACCES: permission denied')
})
