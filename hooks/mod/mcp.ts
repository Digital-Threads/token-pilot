/**
 * The mod's one unmatched `tool.call` hook (engine rule: one per event). It
 * handles token-pilot's own MCP tools:
 *
 *  - Worktree paths. The MCP server fixes its root at start; a session that
 *    `cd`s into a git worktree would have relative paths read from the main
 *    checkout. `$.session.cwd()` follows the main session's `cd`, so its paths
 *    are rewritten here, through `next()`, which keeps Claude Code's
 *    permission prompt as it is. A subagent's `cd` is not visible to the mod
 *    (verified live, 2.1.289), so subagent calls — and the whole-tree warning —
 *    stay with the hook-mcp-path command hook, which reads each call's own
 *    cwd. Paths the mod made absolute reach that hook unchanged.
 *  - read_for_edit calls, recorded so the Edit gate (edit.ts) knows which
 *    files were prepared — no tmp file, no hashing.
 */

import type { EngineInterface, On } from 'claude-code'
import { decideMcpPath } from '../../src/hooks/mcp-path.js'
import { dirname, isAbsolute, normalize, resolve } from '../../src/core/portable-path.js'
import { caught, findCheckout, PREFIX, prepKey } from './host.js'

// hook-mcp-path keeps running: it serves subagent calls and the warnings.
export const MCP_ACTIONS: string[] = []

const TTL_MS = 30 * 60 * 1000 // same as src/core/edit-prep-state.ts

export type EditPrep = {
  mark(path: string): void
  isFresh(path: string, now: number): boolean
}

/** read_for_edit calls seen in this session. A plugin reload clears it; the Edit gate then asks again. */
export function createEditPrep(): EditPrep {
  const seen = new Map<string, number>()

  return {
    mark: path => {
      seen.set(normalize(path), Date.now())
    },
    isFresh: (path, now) => now - (seen.get(normalize(path)) ?? -Infinity) < TTL_MS,
  }
}

const checkouts = new Map<string, string | null>()

async function checkoutOf($: EngineInterface, dir: string): Promise<string | null> {
  if (!checkouts.has(dir)) checkouts.set(dir, await findCheckout(p => $.fs.exists(p), dir))

  return checkouts.get(dir) ?? null
}

export function registerMcp(on: On, prep: EditPrep): void {
  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith(PREFIX)) return next(e)
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)
    if (e.agentId !== undefined) return observe($, e, await next(e), prep)

    const args = e as unknown as Record<string, unknown>
    const root = await $.session.root()
    const cwd = await $.session.cwd()
    const serverCheckout = await checkoutOf($, root)
    const sessionCheckout = await checkoutOf($, cwd)
    const decision = decideMcpPath(
      { tool_name: e.tool, tool_input: args, cwd },
      {
        projectRoot: root,
        checkoutOf: dir => (dir === root ? serverCheckout : dir === cwd ? sessionCheckout : null),
      },
    )

    const call = decision.kind === 'rewrite' ? { ...e, ...decision.updatedInput } : e

    return observe($, call, await next(call), prep)
  }).catch(caught)
}

/** Record a successful read_for_edit for the Edit gate; hand the result back unchanged. */
async function observe<R extends { deny?: unknown; isError?: unknown }>(
  $: EngineInterface,
  call: { tool: string },
  ran: R,
  prep: EditPrep,
): Promise<R> {
  const path = (call as unknown as Record<string, unknown>).path
  if (call.tool === `${PREFIX}read_for_edit` && ran.deny === undefined && !ran.isError && typeof path === 'string') {
    const abs = isAbsolute(path) ? path : resolve(await $.session.root(), path)
    prep.mark(prepKey(await checkoutOf($, dirname(abs)), abs))
  }

  return ran
}
