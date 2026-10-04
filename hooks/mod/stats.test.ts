import { test, expect } from 'claude-code/testing'

test('/tp-stats loads session analytics and opens the pane', async ($, on) => {
  const opened: unknown[] = []
  on('env.get', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async () => ({ value: false }))
  on('ui.open', async (_$: any, e: any) => {
    opened.push(e)
    return { value: undefined }
  })
  on('tool.call', async () => ({ result: 'x', text: 'Saved 12k tokens' }))

  const out: any = await ($ as any).command.run({ command: 'tp-stats', args: '' })

  expect(out.text).toContain('opened')
  expect(opened.length).toBe(1)
})
