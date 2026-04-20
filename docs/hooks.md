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

The Grep hook redirects symbol-like patterns to `find_usages`. The Bash hook blocks:

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

## Analytics & Audit

```bash
token-pilot stats                          # totals + top files from hook-events.jsonl
token-pilot stats --session[=<id>]         # filter by session
token-pilot stats --by-agent              # grouped by agent
token-pilot tool-audit                    # per-tool savings distribution (cumulative)
token-pilot tool-audit --json             # machine-readable output
```

Hook events accumulate in `.token-pilot/hook-events.jsonl`. The `session_analytics` MCP tool provides per-tool breakdown within the current session.
