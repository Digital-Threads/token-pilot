import { test, expect } from 'claude-code/testing'

const stubs = (on: any) => {
  on('env.get', async () => ({ value: undefined }))
}

test('points a symbol-like Grep at find_usages', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'content', numFiles: 0, filenames: [] } }) as any)

  const res: any = await $.tool.call({ tool: 'Grep', pattern: 'decidePreBash', output_mode: 'content' } as any)

  expect(res.deny).toContain('find_usages')
})

test('a plain-text Grep passes', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'content', numFiles: 1, filenames: ['a'] }, text: 'a' }) as any)

  const res: any = await $.tool.call({ tool: 'Grep', pattern: 'error: .* failed' } as any)

  expect(res.deny).toBe(undefined)
})
