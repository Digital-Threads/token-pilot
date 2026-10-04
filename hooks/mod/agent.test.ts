import { test, expect } from 'claude-code/testing'

const AGENT = '---\nname: tp-pr-reviewer\ndescription: Use this when the user asks to review a diff ("review these changes", "look at my PR")\n---\nbody\n'

const base = (on: any, env: Record<string, string> = {}, seen?: { prompt?: string }) => {
  on('env.get', async (_$: any, e: any) => ({ value: env[e.name] }))
  on('fs.list', async () => ({ value: [{ name: 'tp-pr-reviewer.md' }] }))
  on('fs.read', async () => ({ value: AGENT }))
  on('tool.call', { tool: 'Agent' }, async (_$: any, e: any) => {
    if (seen) seen.prompt = e.prompt
    return { result: {}, text: 'launched' } as any
  })
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

const launch = ($: any, subagent_type: string) =>
  $.tool.call({ tool: 'Agent', subagent_type, description: 'tidy up', prompt: 'TASK' } as any)

test('hands the tool guide to the subagent, not to the parent', async ($, on) => {
  const seen: { prompt?: string } = {}
  base(on, {}, seen)

  const res: any = await launch($, 'general-purpose')

  expect(seen.prompt?.startsWith('TASK')).toBe(true)
  // Built after register() marks this a plugin install, not at import.
  expect(seen.prompt).toContain('mcp__plugin_token-pilot_token-pilot__smart_read')
  expect(JSON.stringify(res.context ?? [])).not.toContain('smart_read')
})

test('leaves a tp-* subagent prompt alone', async ($, on) => {
  const seen: { prompt?: string } = {}
  base(on, {}, seen)

  await launch($, 'token-pilot:tp-run')

  expect(seen.prompt).toBe('TASK')
})

test('never re-routes another agent type', async ($, on) => {
  base(on)

  const res: any = await $.tool.call({
    tool: 'Agent',
    subagent_type: 'Plan',
    description: 'review these changes',
    prompt: 'review these changes',
  } as any)

  expect(res.deny).toBe(undefined)
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
