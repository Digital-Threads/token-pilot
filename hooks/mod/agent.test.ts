import { test, expect } from 'claude-code/testing'

const AGENT = '---\nname: tp-pr-reviewer\ndescription: Use this when the user asks to review a diff ("review these changes", "look at my PR")\n---\nbody\n'

const base = (on: any, env: Record<string, string> = {}) => {
  on('env.get', async (_$: any, e: any) => ({ value: env[e.name] }))
  on('fs.list', async () => ({ value: [{ name: 'tp-pr-reviewer.md' }] }))
  on('fs.read', async () => ({ value: AGENT }))
  on('tool.call', { tool: 'Agent' }, async () => ({ result: {}, text: 'launched' }) as any)
}

const dispatch = ($: any) =>
  $.tool.call({
    tool: 'Agent',
    subagent_type: 'general-purpose',
    description: 'review these changes',
    prompt: 'review these changes for duplication',
  } as any)

test('routes a matching dispatch to the tp-* specialist', async ($, on) => {
  base(on)

  const res: any = await dispatch($)

  expect(res.deny).toContain('tp-pr-reviewer')
})

test('leaves workflow runs to the command hooks', async ($, on) => {
  base(on, { TOKEN_PILOT_WORKFLOW_ID: 'wf-1' })

  const res: any = await dispatch($)

  expect(res.deny).toBe(undefined)
})

test('routes a dispatch made through the legacy Task name too', async ($, on) => {
  base(on)
  on('tool.call', { tool: 'Task' }, async () => ({ result: {}, text: 'launched' }) as any)

  const res: any = await $.tool.call({
    tool: 'Task',
    subagent_type: 'general-purpose',
    description: 'review these changes',
    prompt: 'review these changes for duplication',
  } as any)

  expect(res.deny).toContain('tp-pr-reviewer')
})
