/**
 * /tp-stats — this session's token-pilot savings in a pane, from the MCP
 * server's session_analytics. The command itself is registered in
 * register.ts (its one session.start hook).
 */

import type { On } from 'claude-code'
import { PREFIX, caught } from './host.js'

export const STATS_COMMAND = { name: 'tp-stats', description: 'Show token-pilot savings for this session' }

const PANE = 'tp-stats'
let text = 'No data yet.'

export function registerStats(on: On): void {
  on('command.run', { command: STATS_COMMAND.name }, async $ => {
    const r = await $.tool.call({ tool: `${PREFIX}session_analytics` } as never)
    text = (r.deny === undefined && !r.isError && r.text) || 'No token-pilot data for this session yet.'
    await $.ui.open({ id: PANE, title: 'token-pilot' })

    return { text: 'token-pilot stats opened.' }
  }).catch(caught)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {text.split('\n').map(line => (
          <Text>{line}</Text>
        ))}
      </Box>
    )
  })
}
