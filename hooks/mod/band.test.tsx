import { test, expect } from 'claude-code/testing'

const TURN = { answer: 'ok', text: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true }
const LINE = '[TP saved 1.2k 90%]'

const band = (surface: 'terminal' | 'desktop', hasSurvey = false) => ({
  plugin: 'token-pilot',
  surface,
  component: 'AbovePrompt' as const,
  props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 30, scroll: { offset: 0, bodyRows: 9 }, view: {} },
})

const base = (on: any, env: Record<string, string> = {}) => {
  const runs: any[] = []
  const pins: unknown[] = []

  on('env.get', async (_$: any, e: any) => ({ value: env[e.name] }))
  on('env.set', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 1 },
        { kind: 'seven_day', percentUsed: 29 },
      ],
    },
  }))
  on('process.run', async (_$: any, e: any) => {
    runs.push(e)
    return {
      value: { exitCode: 0, stdout: `\u001b[32m${LINE}\u001b[0m\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', async (_$: any, e: any) => {
    pins.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: 'ok' }))
  on('session.start', async () => ({ cwd: '/repo' }))
  // What the engine draws when the plugin passes.
  on('ui.render', async ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  return { runs, pins }
}

test('draws the savings line above the prompt after a turn, dim and sized to the band', async ($, on) => {
  base(on)

  await ($ as any).turn.complete(TURN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await ($ as any).ui.mount(band(surface))
    const text = await ui.find({ type: 'Text', text: LINE })

    expect(text?.text).toBe(LINE)
    expect(text?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Box' }))?.props.width).toBe(30)
    await ui.unmount()
  }
})

test('leaves the band alone before there is a line and while a survey holds it', async ($, on) => {
  base(on)

  const before = await ($ as any).ui.mount(band('terminal'))
  expect((await before.find({ type: 'Text' }))?.text).toBe('engine')
  await before.unmount()

  await ($ as any).turn.complete(TURN)
  const survey = await ($ as any).ui.mount(band('terminal', true))
  expect((await survey.find({ type: 'Text' }))?.text).toBe('engine')
  await survey.unmount()
})

test('clears a status pin an earlier version left, and waits for the first turn to draw', async ($, on) => {
  const { pins, runs } = base(on)

  await ($ as any).session.start(START)

  expect(pins).toEqual([undefined])
  // Until the first reply the statusLine's first run, made before the hand-off, still shows the line.
  expect(runs).toEqual([])
  const ui = await ($ as any).ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test("hands the script the rate limits in the statusLine's shape, and asks it to print", async ($, on) => {
  const { runs } = base(on)

  await ($ as any).turn.complete(TURN)

  const run = runs[0]
  expect(run.argv[0]).toBe('bash')
  expect(run.argv[1]).toMatch(/hooks\/tp-statusline\.sh$/)
  expect(JSON.parse(run.init.stdin)).toEqual({
    session_id: 's1',
    cwd: '/repo',
    rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 29 } },
  })
  // The script stays quiet for a session the mod draws the band for: not for this call.
  expect(run.init.env).toEqual({ TOKEN_PILOT_MOD: '' })
})

test('skips subagent turns', async ($, on) => {
  const { runs } = base(on)

  await ($ as any).turn.complete({ ...TURN, agentId: 'a1' })

  expect(runs).toEqual([])
})

test('TOKEN_PILOT_NO_MOD=1 leaves the line to the statusLine', async ($, on) => {
  const { runs } = base(on, { TOKEN_PILOT_NO_MOD: '1' })

  await ($ as any).session.start(START)
  await ($ as any).turn.complete(TURN)

  expect(runs).toEqual([])
  const ui = await ($ as any).ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
