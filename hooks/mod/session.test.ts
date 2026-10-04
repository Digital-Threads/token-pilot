import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'

const base = (on: any) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'session-base' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async () => ({ deny: 'no such file' }))
  on('fs.stat', async () => ({ deny: 'no such file' }))
  on('fs.list', async () => ({ value: [] }))
  on('prompt.compose', async () => ({ sections: [{ id: 'base', scope: 'shared', text: 'BASE' }] }))
}

const compose = ($: any, tools: string[]) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools })

test('adds the token-pilot section when our tools are offered', async ($, on) => {
  base(on)

  const out: any = await compose($, ['Read', `${P}smart_read`])
  const ours = out.sections.find((s: any) => s.id === 'token-pilot')

  expect(ours?.scope).toBe('session')
  expect(ours?.text).toContain('smart_read')
  expect(out.sections[0].id).toBe('base')
})

test('adds nothing when our tools are not offered', async ($, on) => {
  base(on)

  const out: any = await compose($, ['Read', 'Bash'])

  expect(out.sections.map((s: any) => s.id)).toEqual(['base'])
})

test('rebuilds the section for a new session (after /clear)', async ($, on) => {
  let session = 'session-1'
  let profile: string | undefined
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'TOKEN_PILOT_PROFILE' ? profile : undefined }))
  on('session.id', async () => ({ value: session }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async () => ({ deny: 'no such file' }))
  on('fs.stat', async () => ({ deny: 'no such file' }))
  on('fs.list', async () => ({ value: [] }))
  on('prompt.compose', async () => ({ sections: [{ id: 'base', scope: 'shared', text: 'BASE' }] }))

  const first: any = await compose($, [`${P}smart_read`])
  session = 'session-2'
  profile = 'minimal'
  const second: any = await compose($, [`${P}smart_read`])

  const text = (out: any) => out.sections.find((s: any) => s.id === 'token-pilot')?.text ?? ''
  expect(text(first)).not.toContain('TOKEN_PILOT_PROFILE=minimal')
  expect(text(second)).toContain('TOKEN_PILOT_PROFILE=minimal')
})

test("lists the plugin's own agents under their dispatch name", async ($, on) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'session-plugin-agents' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async (_$: any, e: any) =>
    String(e.path ?? e).endsWith('/tp-debugger.md')
      ? { value: '---\nname: tp-debugger\ndescription: bugs\n---\n' }
      : { deny: 'no such file' },
  )
  on('fs.stat', async () => ({ deny: 'no such file' }))
  // Only the plugin's agents/ holds agents; .claude/agents dirs are empty.
  on('fs.list', async (_$: any, e: any) => ({
    value: String(e.path ?? e).endsWith('.claude/agents') ? [] : [{ name: 'tp-debugger.md' }],
  }))
  on('prompt.compose', async () => ({ sections: [] }))

  const out: any = await compose($, [`${P}smart_read`])
  const text = out.sections.find((s: any) => s.id === 'token-pilot')?.text ?? ''

  expect(text).toContain('token-pilot:tp-debugger')
  expect(text).not.toContain('none installed')
})
