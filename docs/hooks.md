# Hooks & Enforcement Modes

Token Pilot installs two categories of PreToolUse hooks in Claude Code:

1. **Read hook** — intercepts large `Read` calls (configurable threshold, default 300 lines) and returns a structural summary in the denial reason.
2. **Grep / Bash hooks** — block heavy recursive patterns (`grep -r`, `find /`, `cat <file.ts>`, unbounded `git log`, bare `git diff`) and redirect to token-pilot MCP equivalents.

## TOKEN_PILOT_MODE — Enforcement Mode

Controls how aggressively both hook categories behave:

| Value | Grep/Bash hooks | MCP output |
|-------|----------------|------------|
| `advisory` | Pass all through (no blocking) | No caps |
| `deny` *(default)* | Block heavy patterns, allow bounded variants | No caps |
| `strict` | Same as deny, plus auto-cap MCP output (see below) | Capped |

```bash
# Set in your MCP server env block or shell profile:
TOKEN_PILOT_MODE=strict npx token-pilot
```

### Strict-mode MCP output caps

When `TOKEN_PILOT_MODE=strict` and the caller has not set the parameter explicitly:

| Tool | Auto-injected default | Note appended |
|------|-----------------------|---------------|
| `smart_read` | `max_tokens: 2000` | Yes |
| `explore_area` | `include: ["outline"]` | Yes |
| `find_usages` | `mode: "list"` | Yes |
| `smart_log` | `count: 20` | Yes |

Pass the parameter explicitly to override the cap.

## Read Hook Modes

The PreToolUse:Read hook has its own mode (separate from enforcement mode). Set in `.token-pilot.json`:

| Mode | Behaviour |
|------|-----------|
| `off` | Hook is inert — all `Read` calls pass through |
| `advisory` | Denies unbounded Read with a short tip pointing at `smart_read` / `read_for_edit` |
| `deny-enhanced` *(default)* | Denies the Read and returns a full structural summary (imports, exports, declarations) **inside** the denial reason. Works for subagents that lack MCP access. |

```json
{ "hooks": { "mode": "deny-enhanced", "denyThreshold": 300 } }
```

## Grep / Bash Hook Rules

The Grep hook redirects symbol-like patterns searched with `output_mode: "content"`
to `find_usages` (Claude Code's Grep lists file names when `output_mode` is left
out, so those pass). The Bash hook blocks:

| Pattern | Blocked when | Allowed when |
|---------|-------------|--------------|
| `grep -r`/`-R` | Always (unbounded) | Has `-m N` bound |
| `find /`, `find ~` | No `-maxdepth` | Has `-maxdepth N` |
| `cat <file.ts>` | Code file, no pipeline | In pipeline (`cat … \| head`) or non-code file |
| `git log` | No count limit | Has `-n N`, `--max-count`, or `\| head` |
| `git diff` | Bare (no path/flag) | Has path arg or `--stat` |
| `bash -c "…"`, `eval "…"` | Inner command is heavy | Inner command is benign |

## Installing / Removing Hooks

```bash
npx token-pilot install-hook      # register PreToolUse hooks in Claude Code
npx token-pilot uninstall-hook    # remove hooks
```

Hooks are auto-installed on first server start inside Claude Code. The Claude Code plugin path installs hooks automatically:

```bash
claude plugin marketplace add https://github.com/Digital-Threads/token-pilot
claude plugin install token-pilot@token-pilot
```

## Environment Variables

| Var | Effect |
|-----|--------|
| `TOKEN_PILOT_MODE` | `advisory` / `deny` (default) / `strict` — enforcement level for Grep/Bash hooks and MCP output caps |
| `TOKEN_PILOT_BYPASS=1` | Pass every Read through (Read hook only) |
| `TOKEN_PILOT_DENY_THRESHOLD=<n>` | Override `hooks.denyThreshold` (default 300) |
| `TOKEN_PILOT_ADAPTIVE_THRESHOLD=true` | Enable adaptive curve as session burns |
| `TOKEN_PILOT_DEBUG=1` | Verbose hook logging to stderr |
| `TOKEN_PILOT_NO_AGENT_REMINDER=1` | Suppress the "tp-* not installed" stderr nudge |
| `TOKEN_PILOT_SUBAGENT=1` | Mark the MCP server as running inside a subagent |
| `TOKEN_PILOT_NO_MOD=1` | Claude Code: keep every hook on the command path, as if the mod were not loaded |

## Analytics & Audit

```bash
token-pilot stats                          # totals + top files from hook-events.jsonl
token-pilot stats --session[=<id>]         # filter by session
token-pilot stats --by-agent              # grouped by agent
token-pilot tool-audit                    # per-tool savings distribution (cumulative)
token-pilot tool-audit --json             # machine-readable output
```

Hook events accumulate in `.token-pilot/hook-events.jsonl`. The `session_analytics` MCP tool provides per-tool breakdown within the current session.

## Claude Code mods

Claude Code 2.1.275 and later can run a plugin's hooks as a TypeScript module
inside Claude Code itself, instead of starting a process for every tool call.
The token-pilot plugin ships both: `hooks/hooks.json` names the module
(`hooks/mod/register.ts`) and keeps the command hooks.

At session start the module sets `TOKEN_PILOT_MOD` to the hook actions it
handles, and `hooks/run.sh` exits straight away for those. When the module does
not load — an older Claude Code, mods turned off by your organisation, a load
error — the variable is never set and the command hooks run as they did in
0.53. Codex and npm installs (`token-pilot install-hook`) never use the module.
Set `TOKEN_PILOT_NO_MOD=1` to keep a Claude Code session on the command hooks.
The hand-off is tied to the sessions the module has served
(`TOKEN_PILOT_MOD_SESSION`, the last eight): a `claude` started from that
session's shell inherits the variables, and its command hooks still run unless
its own module takes over. After `/clear` the earlier session stays listed, so
its background agents keep the hand-off; after `/resume` the resumed session is
listed.

A module hook that fails is skipped and the tool call goes ahead; the failure
and Claude Code's reason are recorded in `~/.token-pilot/hook-errors.jsonl`
(`token-pilot errors`), unless `TOKEN_PILOT_NO_ERROR_LOG=1`. The module only
ever appends to its logs — through `sh`, or `node` where there is no `sh` — and
archives a full log first, as the CLI does.

What changes when the module runs:

| Hook | With the module |
|------|-----------------|
| Read | A whole-file Read of a large code file returns the file's outline from `smart_read` as a normal Read result. The first line says it is an outline and how to get exact lines. The command hook refused the read instead, and the model had to recover. An Edit of the file afterwards works as usual. Files of 4 MiB and up, or that Claude Code will not read, are gated by their line count. |
| Edit | Knows which files went through `read_for_edit` from the calls it saw in this session, so there is no state file. Strict mode refuses an unprepared Edit, the default mode adds a note — as before. |
| Bash, Grep | Same rules, no process per call. The note after a very large Bash output arrives together with the result. Claude Code 2.1.289 has no Grep tool; search goes through Bash. |
| Agent | Same routing, no process per dispatch. Budgets and task telemetry stay with the SubagentStop command hook: agents run in the background by default, so only SubagentStop sees the final answer. Workflow runs (`TOKEN_PILOT_WORKFLOW_ID`, `CLAUDE_CODE_WORKFLOW_ID`, `LOOM_WORKFLOW_ID`) keep routing on the command hooks too, which add the workflow budget note. |
| token-pilot's MCP tools | In the main session, relative paths are mapped into the worktree the session moved into, and the permission prompt is left alone. The module cannot see a subagent's `cd`, so subagent calls and the note on whole-tree tools stay with the `hook-mcp-path` command hook. |
| SessionStart, UserPromptSubmit | The token-pilot guidance becomes a section of the system prompt. It is built once per session and does not change, so the prompt cache keeps it, and it is no longer repeated on every turn. If token-pilot is also registered in a settings file, that shows up as a notification. |
| Status | A savings line from `hooks/tp-statusline.sh` under the prompt, refreshed after each turn. It stays hidden while the `statusLine` in effect — Claude Code's merge of user, project, local, `--settings` and managed settings, read again every turn — already runs that script. |
| `/tp-stats` | Opens this session's `session_analytics` in a side pane. |

Not carried over to the module: the subagent-adoption nudge (it read the whole
event log at every start), the bootstrap notes (a plugin always carries its
agents, and the MCP server reports a missing `ast-index` itself) and
SessionStart's `watchPaths`.

## Codex CLI

Codex reads lifecycle hooks from `~/.codex/hooks.json` or
`<repo>/.codex/hooks.json`, in the same `{matcher, hooks: [{type, command}]}`
shape Claude Code uses, and honours the same `hookSpecificOutput`
(`permissionDecision`, `permissionDecisionReason`, `additionalContext`) and the
exit-2 fallback. token-pilot reuses its handlers unchanged:

```bash
npx token-pilot install-hook --client=codex                  # ~/.codex/hooks.json
npx token-pilot install-hook --client=codex --scope=project  # <repo>/.codex/hooks.json
npx token-pilot uninstall-hook --client=codex
```

Run `/hooks` inside Codex once after installing — Codex does not execute a
hook definition it has not been shown.

| Event | Matcher | Handler |
|-------|---------|---------|
| `PreToolUse` | `Bash` | shell rules (`cat`, recursive `grep`, unbounded `git log` / `git diff`) |
| `PostToolUse` | `Bash` | post-command advisory |
| `SessionStart` | — | project context |
| `UserPromptSubmit` | — | per-turn reminder |

Not wired, on purpose: Codex has no file-read tool (its model reads through the
shell, which the `Bash` rules already cover), and both `apply_patch` and
`spawn_agent` carry payloads that differ from Claude Code's `Edit` and `Agent`
— the read-gate and the routing hook would be reasoning about fields that are
not there.

## Git worktrees

The MCP server resolves relative paths against the project root it started
with. When a session moves into a git worktree (`cd .worktrees/feature`), a
PreToolUse hook on token-pilot's own tools resolves relative `path` / `paths`
arguments against the checkout the session is actually in, so reads return the
worktree's file rather than the same file from the main checkout. In the
server's own checkout the hook prints nothing.

Tools that look past a single file — the symbol index behind `find_usages`,
`project_overview` and similar, git history and diffs, test runs — still answer
from the server's checkout. In a worktree session they arrive with a note
saying so.

Absolute paths into another worktree of the same repository are accepted, so a
sibling checkout (`git worktree add ../feature`) can be read directly. Claude
Code resets a Bash `cd` that leaves the project directory, so absolute paths or
`--add-dir` are how a session reaches a sibling worktree.
