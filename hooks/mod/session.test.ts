import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'

const LEGACY = '---\nname: tp-run\ntools:\n  - mcp__token-pilot__smart_read\ntoken_pilot_body_hash: abc\n---\n'

type Engine = {
  env?: Record<string, string>
  files?: Record<string, string>
  dirs?: Record<string, string[]>
  mtimeMs?: number
}

const base = (on: any, session: string, engine: Engine = {}) => {
  const path = (e: any) => String(e.path ?? e)
  on('env.get', async (_$: any, e: any) => ({ value: engine.env?.[e.name] }))
  on('session.id', async () => ({ value: session }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async (_$: any, e: any) =>
    engine.files?.[path(e)] !== undefined ? { value: engine.files[path(e)] } : { deny: 'no such file' },
  )
  on('fs.stat', async () => (engine.mtimeMs === undefined ? { deny: 'no such file' } : { value: { mtimeMs: engine.mtimeMs, size: 1 } }))
  on('fs.list', async (_$: any, e: any) => ({ value: (engine.dirs?.[path(e)] ?? []).map(name => ({ name })) }))
  on('prompt.compose', async () => ({ sections: [{ id: 'base', scope: 'shared', text: 'BASE' }] }))
}

const compose = ($: any, tools: string[]) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools })

const ids = (out: any) => out.sections.map((s: any) => s.id)

test('gives the model no rules and no agent list', async ($, on) => {
  base(on, 'session-quiet')

  const out: any = await compose($, ['Read', `${P}smart_read`])

  expect(ids(out)).toEqual(['base'])
})

test('points the model at a fresh snapshot, in one line', async ($, on) => {
  base(on, 'session-snapshot', {
    files: { '/repo/.token-pilot/snapshots/latest.md': '**Goal:** ship 1.0.6\n' },
    mtimeMs: Date.now(),
  })

  const out: any = await compose($, [`${P}smart_read`])
  const ours = out.sections.find((s: any) => s.id === 'token-pilot')

  expect(ours?.scope).toBe('session')
  expect(ours?.text).toContain('ship 1.0.6')
  expect(ours?.text.split('\n')).toHaveLength(1)
})

test('adds nothing when our tools are not offered', async ($, on) => {
  base(on, 'session-no-tools')

  const out: any = await compose($, ['Read', 'Bash'])

  expect(ids(out)).toEqual(['base'])
})

test('tells the person, not the model, about old agent copies', async ($, on) => {
  const toasts: string[] = []
  base(on, 'session-legacy', {
    env: { HOME: '/home/u' },
    dirs: { '/home/u/.claude/agents': ['tp-run.md', 'notes.md'] },
    files: { '/home/u/.claude/agents/tp-run.md': LEGACY },
  })
  on('ui.toast', async (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const out: any = await compose($, [`${P}smart_read`])
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(ids(out)).toEqual(['base'])
  expect(toasts.join('\n')).toContain('1 tp-*.md in /home/u/.claude/agents')
  expect(toasts.join('\n')).toContain('npx token-pilot uninstall-agents --scope=user')
})

test('reads user agents where Claude Code does: CLAUDE_CONFIG_DIR/agents', async ($, on) => {
  const toasts: string[] = []
  base(on, 'session-config-dir', {
    env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/profile' },
    dirs: { '/home/u/profile/agents': ['tp-run.md'] },
    files: { '/home/u/profile/agents/tp-run.md': LEGACY },
  })
  on('ui.toast', async (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await compose($, [`${P}smart_read`])
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(toasts.join('\n')).toContain('1 tp-*.md in /home/u/profile/agents')
  expect(toasts.join('\n')).toContain('CLAUDE_CONFIG_DIR=/home/u/profile npx token-pilot uninstall-agents --scope=user')
})
