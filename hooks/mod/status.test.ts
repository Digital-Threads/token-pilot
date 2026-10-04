import { test, expect } from 'claude-code/testing'

const TURN = { answer: 'ok', text: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }

const runs: unknown[] = []

// `settings` is what the engine merges over every source (user, project,
// local, --settings, managed); a test changes it between turns through `now`.
const base = (on: any, now: { settings: unknown }, shown: unknown[], files: Record<string, unknown> = {}) => {
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('settings.read', async () => ({ value: now.settings }))
  on('fs.read', async (_$: any, e: any) => {
    const path = String(e.path ?? e)
    return path in files ? { value: JSON.stringify(files[path]) } : { deny: 'no such file' }
  })
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.root', async () => ({ value: '/repo' }))
  on('process.run', async (_$: any, e: any) => ({
    ...(runs.push(e), {}),
    value: { exitCode: 0, stdout: '\u001b[32m[TP saved 1.2k 90%]\u001b[0m\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', async (_$: any, e: any) => {
    shown.push(e)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: 'ok' }))
}

test('shows the savings line after a turn, without colour codes', async ($, on) => {
  const shown: unknown[] = []
  base(on, { settings: {} }, shown)

  await ($ as any).turn.complete(TURN)

  expect(JSON.stringify(shown)).toContain('[TP saved 1.2k 90%]')
  expect(JSON.stringify(shown)).not.toContain('\\u001b')
  // tp-statusline.sh uses bash-only $'\\033' quoting; under sh it prints it literally.
  expect(JSON.stringify(runs)).toContain('"bash"')
})

test('stays quiet when the effective statusLine already runs token-pilot', async ($, on) => {
  const shown: unknown[] = []
  base(on, { settings: { statusLine: { command: 'sh ~/x/hooks/tp-statusline.sh' } } }, shown)

  await ($ as any).turn.complete(TURN)

  expect(shown).toEqual([])
})

test('follows the merged settings, so managed or --settings statusLines count', async ($, on) => {
  const shown: unknown[] = []
  base(on, { settings: { statusLine: { command: 'managed-line' } } }, shown, {
    '/home/u/.claude/settings.json': { statusLine: { command: 'sh ~/x/hooks/tp-statusline.sh' } },
  })

  await ($ as any).turn.complete(TURN)

  expect(JSON.stringify(shown)).toContain('[TP saved 1.2k 90%]')
})

test('checks the statusLine again each turn', async ($, on) => {
  const shown: unknown[] = []
  const now = { settings: { statusLine: { command: 'bash hooks/tp-statusline.sh' } } as unknown }
  base(on, now, shown, { '/home/u/.claude/settings.json': now.settings })

  await ($ as any).turn.complete(TURN)
  expect(shown).toEqual([])
  now.settings = { statusLine: { command: 'my-own-line' } }
  await ($ as any).turn.complete(TURN)

  expect(JSON.stringify(shown)).toContain('[TP saved 1.2k 90%]')
})
