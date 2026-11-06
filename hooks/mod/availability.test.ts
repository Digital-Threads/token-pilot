import { test, expect } from 'claude-code/testing'

// A gate that refuses Read or a shell read helps only when the model can call
// smart_read instead. Without token-pilot's tools in the session it costs a
// turn and names a tool that does not exist, so the gates step aside.

const P = 'mcp__plugin_token-pilot_token-pilot__'
const BIG = 'const x = 1;\n'.repeat(800)

type Engine = { env?: Record<string, string>; files?: Record<string, string> }

const base = (on: any, engine: Engine = {}) => {
  on('env.get', async (_$: any, e: any) => ({ value: engine.env?.[e.name] }))
  on('env.set', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.read', async (_$: any, e: any) => {
    const path = String(e.path ?? e)
    if (engine.files?.[path] !== undefined) return { value: engine.files[path] }

    return path.endsWith('.ts') ? { value: BIG } : { deny: 'no such file' }
  })
  on('fs.stat', async (_$: any, e: any) => ({ value: { realPath: e.path, size: BIG.length } }))
  on('fs.list', async () => ({ value: [] }))
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.compose', async () => ({ sections: [] }))
  on('classic.SessionStart', async () => ({}))
}

/** Every tool the tests call; records which ones ran. */
const tools = (on: any, ran: string[], smartRead: () => unknown = () => ({ result: 'OUTLINE', text: 'FILE: a.ts\nfunction f() [L1-2]' })) =>
  on('tool.call', async (_$: any, e: any) => {
    ran.push(e.tool)
    if (e.tool === `${P}smart_read`) return smartRead()
    if (e.tool === 'Read') {
      return { result: { type: 'text', file: { filePath: e.file_path, content: 'TEXT', numLines: 1, startLine: 1, totalLines: 801 } } }
    }
    if (e.tool === 'Grep') return { result: { mode: 'content', numFiles: 0, filenames: [] } }

    return { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
  })

const compose = ($: any, offered: string[]) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: offered })

test('the session offers none of our tools: a whole-file Read of a big code file passes untouched', async ($, on) => {
  const ran: string[] = []
  base(on)
  tools(on, ran)

  await compose($, ['Read', 'Bash', 'Grep'])
  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.deny).toBe(undefined)
  expect(res.result.file.content).toBe('TEXT')
  expect(ran).toEqual(['Read'])
})

test('the session offers none of our tools: cat of a code file and a symbol Grep pass', async ($, on) => {
  const ran: string[] = []
  base(on)
  tools(on, ran)

  await compose($, ['Read', 'Bash', 'Grep'])
  const cat: any = await $.tool.call({ tool: 'Bash', command: 'cat /repo/src/a.ts' } as any)
  const grep: any = await $.tool.call({ tool: 'Grep', pattern: 'decidePreBash' } as any)

  expect(cat.deny).toBe(undefined)
  expect(grep.deny).toBe(undefined)
})

test('/mcp turned our server off and prompt.compose never ran: Read passes untouched', async ($, on) => {
  const ran: string[] = []
  base(on, {
    env: { HOME: '/home/u' },
    files: { '/home/u/.claude.json': JSON.stringify({ projects: { '/repo': { disabledMcpServers: ['token-pilot'] } } }) },
  })
  tools(on, ran)

  await ($ as any).classic.SessionStart({ source: 'startup', session_id: 's1' })
  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.deny).toBe(undefined)
  expect(ran).toEqual(['Read'])
})

test('/mcp turned our server off for the repository and the session runs in its worktree: Read passes untouched', async ($, on) => {
  const ran: string[] = []
  const wt = '/repo/.worktrees/wt'
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('env.set', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.root', async () => ({ value: wt }))
  on('session.cwd', async () => ({ value: wt }))
  on('fs.exists', async (_$: any, e: any) => ({ value: String(e.path ?? e) === `${wt}/.git` }))
  on('fs.read', async (_$: any, e: any) => {
    const path = String(e.path ?? e)
    if (path === `${wt}/.git`) return { value: 'gitdir: /repo/.git/worktrees/wt\n' }
    if (path === '/home/u/.claude.json') return { value: JSON.stringify({ projects: { '/repo': { disabledMcpServers: ['token-pilot'] } } }) }

    return path.endsWith('.ts') ? { value: BIG } : { deny: 'no such file' }
  })
  on('fs.stat', async (_$: any, e: any) => ({ value: { realPath: e.path, size: BIG.length } }))
  on('fs.list', async () => ({ value: [] }))
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('prompt.compose', async () => ({ sections: [] }))
  on('classic.SessionStart', async () => ({}))
  tools(on, ran)

  await ($ as any).classic.SessionStart({ source: 'startup', session_id: 's1' })
  const res: any = await $.tool.call({ tool: 'Read', file_path: `${wt}/src/a.ts` } as any)

  expect(res.deny).toBe(undefined)
  expect(ran).toEqual(['Read'])
})

test('our tools offered: a whole-file Read of a big code file still comes back as the outline', async ($, on) => {
  const ran: string[] = []
  base(on)
  tools(on, ran)

  await compose($, ['Read', `${P}smart_read`])
  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.result.file.content).toContain('function f()')
})

test('nothing said whether our tools are there and smart_read is not answered: Read passes untouched', async ($, on) => {
  const ran: string[] = []
  base(on)
  tools(on, ran, () => ({ deny: 'No such tool available' }))

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.deny).toBe(undefined)
  expect(res.result.file.content).toBe('TEXT')
})
