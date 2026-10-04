/**
 * Edit, in-process: an Edit of an existing code file must follow a
 * read_for_edit of that file. The mod knows which files were prepared from
 * the read_for_edit calls it saw (mcp.ts), so there is no tmp-file state and
 * no hashing. Replaces the hook-edit command hook.
 */

import type { On } from 'claude-code'
import { decidePreEdit } from '../../src/hooks/pre-edit.js'
import { isCodeFile } from '../../src/hooks/read-gate.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import type { EditPrep } from './mcp.js'
import { dirname } from '../../src/core/portable-path.js'
import { caught, findCheckout, prepKey, withContext } from './host.js'

export const EDIT_ACTIONS = ['hook-edit']

export function registerEdit(on: On, prep: EditPrep): void {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if ((await $.env.get('TOKEN_PILOT_NO_MOD')) === '1') return next(e)

    const filePath = String(e.file_path ?? '')
    const decision = decidePreEdit(
      { tool_name: 'Edit', tool_input: { file_path: filePath } },
      {
        mode: parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE')),
        isCodeFile: isCodeFile(filePath),
        fileExists: await $.fs.exists(filePath),
        isPrepared: prep.isFresh(
          prepKey(await findCheckout(p => $.fs.exists(p), dirname(filePath)), filePath),
          Date.now(),
        ),
        bypassed: (await $.env.get('TOKEN_PILOT_BYPASS')) === '1',
      },
    )
    if (decision.kind === 'deny') return { deny: decision.reason }

    return withContext(await next(e), decision.kind === 'advise' ? [decision.message] : [])
  }).catch(caught)
}
