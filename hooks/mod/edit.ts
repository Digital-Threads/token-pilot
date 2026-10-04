/**
 * Edit, in-process: an Edit of an existing code file must follow a
 * read_for_edit of that file. The mod knows which files were prepared from
 * the read_for_edit calls it saw (mcp.ts), so there is no tmp-file state and
 * no hashing. Replaces the hook-edit command hook.
 *
 * A file the agent wrote itself (Write) counts as prepared: it knows every
 * byte. A file outside the project is not gated — read_for_edit refuses it.
 */

import type { EngineInterface, On } from 'claude-code'
import { decidePreEdit } from '../../src/hooks/pre-edit.js'
import { isCodeFile } from '../../src/hooks/read-gate.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import type { EditPrep } from './mcp.js'
import { dirname } from '../../src/core/portable-path.js'
import { caught, findCheckout, isInside, prepKey, withContext } from './host.js'

export const EDIT_ACTIONS = ['hook-edit']

async function realPath($: EngineInterface, path: string): Promise<string> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => null)

  return stat?.realPath ?? path
}

async function keyOf($: EngineInterface, filePath: string): Promise<string> {
  return prepKey(await findCheckout(p => $.fs.exists(p), dirname(filePath)), filePath)
}

export function registerEdit(on: On, prep: EditPrep): void {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)

    const filePath = String(e.file_path ?? '')
    const fileExists = await $.fs.exists(filePath)
    const decision = decidePreEdit(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      {
        mode: parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE')),
        isCodeFile: isCodeFile(filePath),
        fileExists,
        isPrepared: prep.isFresh(await keyOf($, filePath), Date.now()),
        bypassed: (await $.env.get('TOKEN_PILOT_BYPASS')) === '1',
        outsideProject:
          fileExists && !isInside(await realPath($, await $.session.root()), await realPath($, filePath)),
      },
    )
    if (decision.kind === 'deny') return { deny: decision.reason }

    return withContext(await next(e), decision.kind === 'advise' ? [decision.message] : [])
  }).catch(caught)

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    const filePath = String(e.file_path ?? '')
    if (ran.deny === undefined && !ran.isError && isCodeFile(filePath)) prep.mark(await keyOf($, filePath))

    return ran
  }).catch(caught)
}
