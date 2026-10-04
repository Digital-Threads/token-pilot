# Claude Code mods — design

Date: 2026-10-04. Target release: **1.0.0** (one major release at the end).

## Why

Every token-pilot hook in Claude Code is a separate process today. Claude Code
starts `sh hooks/run.sh` → `node dist/index.js hook-…` for each matching tool
call. That costs about 200 ms per Read, Bash, Grep, Edit and Agent call, and the
MCP-path hook costs 23 ms. The process boundary also forces some awkward
workarounds:

- a rewrite of tool arguments only works together with
  `permissionDecision: "allow"`, which also skips the permission prompt (0.53.1);
- `read_for_edit` state is shared through a tmp file keyed by a sha1 of the
  project root;
- subagent budgets are measured by parsing transcript files;
- the session reminder is re-sent with every user prompt (UserPromptSubmit);
- the savings badge lives in the user's one `statusLine` slot, which
  `/statusline` once wiped.

Claude Code 2.1.275+ loads **mods**: a plugin's `hooks/hooks.json` can name a
TypeScript module (`"modules": ["./…"]`). The module runs inside Claude Code and
registers function hooks with `on(event, matcher?, ($, e, next) => …)`. It has
no Node — files, env, processes and tools are reached through `$`.

## Verified facts (spike, 2026-10-04)

The spike lived in the session scratchpad: `tp-mod-spike/`, a copy of
`src/hooks/pre-bash.ts` plus its two dependencies. It ran in live `claude -p`
sessions, in one interactive tmux session, and through `claude plugin test`.

| # | Fact | How verified |
| --- | --- | --- |
| 1 | A mod imports repo TypeScript via `../src/hooks/pre-bash.js` (`.js` resolves to `.ts`). | 2.1.289 live |
| 2 | `globalThis.process` is `undefined` in a mod; `decidePreBash` threw `ReferenceError: process is not defined` from `core/tool-names.ts` until that line was made process-safe. | 2.1.289 live |
| 3 | `tool.call` → `{ deny }` reaches the model as the refusal text; the command never runs. | 2.1.289 live |
| 4 | `tool.call` → `{ ...await next(e), context: [text] }` reaches the model after the tool result (the PostToolUse `additionalContext` equivalent). | 2.1.289 live |
| 5 | `next({ ...e, path })` on an MCP tool changes what the MCP server receives. MCP arguments sit directly on `e`. `next` still runs the permission prompt. | 2.1.289 live + types |
| 6 | `$.session.cwd()` follows `cd` in Bash (after `cd src` an MCP call saw `…/src`). | 2.1.289 live |
| 7 | `prompt.compose` → an appended `{ id, scope: 'session', text }` section reaches the model. `e.tools` lists deferred MCP tools too. | 2.1.289 live |
| 8 | A mod can answer `Read` itself. Both variants work, and in both a following `Edit` on that file succeeds: (A) its own `{ result: { type:'text', file:{…} } }`; (B) `next({ ...e, offset:1, limit:1 })` with the content swapped for a `smart_read` outline. The outline comes from `$.tool.call({ tool: 'mcp__…__smart_read', path })`. | 2.1.289 live |
| 9 | One `hooks.json` with `"modules"` **and** command hooks: 2.1.200 and 2.1.250 run the command hooks and silently ignore the module; 2.1.275, 2.1.286 and 2.1.289 run **both**. | live, 5 versions |
| 10 | `classic.SessionStart` in a mod runs **before** the settings/plugin command hooks (types: chain = managed, modules, then settings hooks). `$.env.set` there is visible to every command hook spawned after, including the command SessionStart. `session.start` alone is too late for SessionStart. | 2.1.289 live |
| 11 | When the mod returns `{ deny }`, the command PreToolUse hook is not spawned at all. | 2.1.289 live |
| 12 | A mod that fails to load (two unmatched `tool.call` hooks — engine rule: at most one unmatched hook per event) leaves the command hooks fully working. | 2.1.289 live |
| 13 | A mod's `tool.call` sees subagent tool calls (`e.agentId` set). Its deny reaches the subagent. | 2.1.289 live |
| 14 | `$.ui.status(text)` draws a line `⚠ <plugin>: <text>` **above** the user's own `statusLine` output. Both stay visible. | 2.1.289 interactive tmux |
| 15 | `claude plugin test` runs a mod's `*.test.ts` with no model call in 0.3 s. Every `$` call the mod makes must be stubbed by the test with `on('<noun>.<method>', async () => ({ value }))`: `undefined`, `null` and `{}` are rejected. | 2.1.289 local |
| 16 | The hook time budget stops while a `$` call or `next` is in flight, so `$.tool.call` to `smart_read` inside a Read hook costs the hook nothing. | types |
| 17 | `$.session.usage()` has no per-agent token figures. Subagent budgets therefore keep estimating from the final response text. | types |
| 18 | Mods appeared in the changelog in 2.1.287 ("Added Claude Mods") but load from 2.1.275. 2.1.288 mentions mods "turned off remotely" — an organisation can disable them. | changelog + item 9 |
| 19 | On `/resume`, `classic.SessionStart` fires while `$.session.id()` still answers the session being left; the payload's `session_id` is the resumed one. In later turns `$.session.id()` answers the resumed session. On `/clear` both are already the new session. | 2.1.289 interactive tmux |
| 23 | Hook payloads put `session_id` first (`{"session_id":…,"transcript_path":…`), for PreToolUse and SessionStart alike. | 2.1.289 captured payloads |
| 20 | A `.catch` handler's `next.error` is `{ kind: 'throw' \| 'timeout', message?, budget }`, not an Error. | types + `claude plugin test` |
| 21 | 2.1.289 has no Grep or Glob tool: search runs through Bash. | types of the build |
| 22 | `$.settings.read()` returns the merge the engine runs under — user, project, local, `--settings`, managed; a statusLine from `--settings` is seen. | 2.1.289 interactive tmux |

## Architecture

One plugin carries both mechanisms:

```
hooks/hooks.json
  "modules": ["./mod/register.ts"]        ← Claude Code ≥ 2.1.275, mods allowed
  "hooks":   { …today's command hooks… }   ← every Claude Code version
```

**Hand-off flag.** In `classic.SessionStart` (and again in `session.start`) the
mod sets `TOKEN_PILOT_MOD` to a comma list of the hook actions it serves, for
example `hook-pre-bash,hook-pre-grep`. `hooks/run.sh` exits 0 before starting
node when its action is in that list. That gives three properties:

- **Hooks move over one at a time.** A hook the mod does not serve yet keeps
  running as a command.
- **Automatic fallback.** If the mod is off (old Claude Code, organisation
  policy, load failure), the flag is never set and every command hook runs as
  today.
- **Codex and npm installs are untouched.** Codex reads its own
  `~/.codex/hooks.json`, and `token-pilot install-hook` writes command hooks
  into settings.json. Neither ever sees the flag.

**Shared logic stays in one place.** Decide functions in `src/hooks/*` and the
helpers they use must not import `node:*` or touch `process`, either directly or
transitively. Each environment does its own I/O and passes plain data in:

- `src/index.ts` is the command path; Node does the I/O.
- `hooks/mod/*.ts` is the mod path; `$` does the I/O.

A vitest guard test fails the build when a module on the mod's import graph
picks up a Node dependency.

**Mod I/O conventions**

| Need | Mod uses |
| --- | --- |
| env | `$.env.get('LITERAL')` (names must be literals; `claude plugin validate` lists them) |
| read a file | `$.fs.read(path)`; `$.fs.exists`, `$.fs.list`, `$.fs.stat` |
| append telemetry | `$.process.run` of a small `sh` appender (`node -e` where there is no `sh`) with the line on stdin, not awaited, best-effort; it archives a full log first and never rewrites the file |
| project root / cwd | `$.session.root()` / `$.session.cwd()` |
| plugin root (agents dir) | `$.plugin.root` |
| call our MCP tools | `$.tool.call({ tool: 'mcp__plugin_token-pilot_token-pilot__smart_read', path })` |
| state that survives hot reload | `$.state` (session), `$.store` (across sessions) |

## Hook-by-hook mapping

| Today (command) | Mod | What gets better |
| --- | --- | --- |
| PreToolUse Read → `hook-read` (deny; the reason carries an ast-index summary) | `tool.call {tool:'Read'}` | No 200 ms process. A big code file **gets its outline back as a normal Read result** (variant B: core reads one line so the file counts as read; content replaced by `smart_read`'s outline plus a header naming `read_symbol` / `read_for_edit` / `offset+limit`). The model no longer sees an error and retries. The outline comes from the MCP server, so the hook needs no ast-index spawn. |
| PreToolUse Edit/MultiEdit → `hook-edit` (tmp-file prep state, sha1) | `tool.call {tool:'Edit'\|'MultiEdit'}` | Prep state comes from `read_for_edit` calls the mod itself sees, kept in module memory. No tmp file, no hashing, no clock skew between processes. A plugin reload clears it, and the gate then asks for `read_for_edit` again, which is the same as the 30-minute expiry. |
| PreToolUse Bash → `hook-pre-bash`; PostToolUse Bash → `hook-post-bash` | one `tool.call {tool:'Bash'}` | Pre-check and post-advice live in one function: deny before, `context` after a large output. |
| PreToolUse Grep → `hook-pre-grep` | `tool.call {tool:'Grep'}` | Speed only. |
| PreToolUse Agent\|Task → `hook-pre-task`; PostToolUse Task → `hook-post-task`; SubagentStop → `hook-subagent-stop` | `tool.call {tool:'Agent'}` | Routing only. Budgets and task telemetry stay on `hook-subagent-stop`: agents run in the background by default, so the Agent result is the launch acknowledgement (found in the final review). |
| PreToolUse `mcp__…token-pilot__*` → `hook-mcp-path.js` | the single unmatched `tool.call` (dispatches by `e.tool`) | `$.session.cwd()` + `next({...e, path})`. **No forced allow**: the permission prompt behaves normally. Whole-tree tools get the worktree warning as `context`. |
| SessionStart → `hook-session-start` + `hook-bootstrap`; UserPromptSubmit → `hook-user-prompt` | `prompt.compose` section + `$.ui.toast` | The MANDATORY block and decision guide become a stable system-prompt section (cached; nothing repeated per turn). Notes for the human (duplicate hook registrations, missing agents) become toasts instead of model context. |
| statusLine `tp-statusline.sh` (user's one slot) | `$.ui.status` | A savings line of its own. Shown only while the merged statusLine (`$.settings.read()`) does not already run token-pilot's script. |
| — | `$.command.register('tp-stats')` + Pane | `/tp-stats` opens session analytics in a pane. |

## Out of scope for 1.0.0

- Native tools via `$.tool.register`. The MCP server stays: Codex, Cursor and
  npm users need it.
- Mods for Codex: Codex has no such engine.
- A worktree band above the prompt. The model-facing `context` note is enough.

## Risks

- **Fail-open on mod errors.** The engine skips a hook that throws and runs
  core, while the command hook has already stepped aside. The result is the
  same fail-open as a crashing command hook. Every hook carries
  `.catch(caught)`, which records the failure in `~/.token-pilot/hook-errors.jsonl`;
  the engine's `next` there is replay-safe, so nothing runs twice.
- **Hot reload drops module variables.** Anything that must survive goes in
  `$.state`.
- **Windows paths.** The mod has no `node:path`. A small `portable-path` module
  handles `/` and `C:\`. Tests cover both.
- **Outline instead of content may surprise the model.** The header says
  plainly what happened and how to get exact text.
- **API churn.** Mods are new: 2.1.287–2.1.289 changed many things. CI pins a
  `claude` version for `claude plugin validate/test`, and the release notes
  state the tested versions.
