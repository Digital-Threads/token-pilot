# Installation Guide

## TL;DR

**Claude Code — plugin (recommended):**
```bash
# New machine:
claude plugin marketplace add https://github.com/Digital-Threads/token-pilot
claude plugin install token-pilot@token-pilot

# Update:
claude plugin update token-pilot
```

**Other clients (Cursor, Codex, Cline, …):**
```bash
# New machine:
npx -y token-pilot init

# Update — npx always pulls fresh, just restart your client.
# Or if installed globally:
npm i -g token-pilot@latest
npx token-pilot install-hook
npx token-pilot install-agents --scope=user --force
```

---

## First-time setup (full walkthrough)

```bash
npx -y token-pilot init
```

Writes `.mcp.json` (or merges into an existing one), adds `token-pilot` + [`context-mode`](https://github.com/mksglu/claude-context-mode), then prompts to install `tp-*` subagents. Restart your AI assistant to activate.

---

## Claude Code

Three paths — pick one, they're mutually exclusive.

### A. Plugin (one-step: hooks + MCP registered together)

```bash
claude plugin marketplace add https://github.com/Digital-Threads/token-pilot
claude plugin install token-pilot@token-pilot
```

Claude Code clones the repo into `~/.claude/plugins/cache/token-pilot/`, sets `CLAUDE_PLUGIN_ROOT`, and registers the MCP server + all hooks declared in `.claude-plugin/hooks/hooks.json`. No `install-hook` call needed. Run `install-agents` separately for the `tp-*` subagents.

### B. MCP config (npm-based, no plugin system)

```bash
claude mcp add token-pilot -- npx -y token-pilot
# or for a specific scope:
claude mcp add --scope user    token-pilot -- npx -y token-pilot
claude mcp add --scope project token-pilot -- npx -y token-pilot
```

Or edit `.mcp.json` (project-level) / `~/.mcp.json` (user-level) directly:

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] },
    "context-mode": { "command": "npx", "args": ["-y", "claude-context-mode"] }
  }
}
```

Then:
```bash
npx token-pilot install-hook                   # register PreToolUse hooks
npx token-pilot install-agents --scope=user    # install tp-* subagents
```

### C. One-liner

```bash
npx -y token-pilot init
```

Writes path B config for you, then prompts about subagents.

---

## Cursor

Cursor reads `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] }
  }
}
```

---

## Codex CLI

Codex reads `~/.codex/config.toml`:

```toml
[mcp_servers.token-pilot]
command = "npx"
args = ["-y", "token-pilot"]
```

---

## Cline (VS Code)

Cline reads `cline_mcp_settings.json` (accessible via Cline panel → MCP Servers → Edit):

```json
{
  "mcpServers": {
    "token-pilot": { "command": "npx", "args": ["-y", "token-pilot"] }
  }
}
```

---

## Gemini CLI

Add to `~/.gemini/settings.json` or follow Gemini CLI MCP documentation for your version.

---

## Any MCP-compatible client

The server is a plain stdio process:

```
command: npx
args:    -y token-pilot
```

No env vars required. Common optional overrides:

| Env var | Default | Purpose |
|---------|---------|---------|
| `TOKEN_PILOT_MODE` | `deny` | `advisory` / `deny` / `strict` — enforcement level |
| `TOKEN_PILOT_PROFILE` | `full` | `nav` / `edit` / `full` — trims `tools/list` payload |
| `TOKEN_PILOT_DENY_THRESHOLD` | `300` | Line count above which the Read hook intervenes |
| `TOKEN_PILOT_ADAPTIVE_THRESHOLD` | `false` | Enable adaptive curve as session burns |
| `TOKEN_PILOT_BYPASS` | unset | Set to `1` to disable the Read hook for one session |
| `TOKEN_PILOT_SKIP_POSTINSTALL` | unset | Skip `ast-index` safety-net install at `npm install` time |

---

## From source (contributors / vendored installs)

```bash
git clone https://github.com/Digital-Threads/token-pilot.git
cd token-pilot && npm install && npm run build
# Point your client's config at dist/index.js:
#   "command": "node", "args": ["/abs/path/to/token-pilot/dist/index.js"]
```

---

## Non-Claude clients

`install-agents` detects non-Claude clients via env vars + filesystem markers (`CURSOR_TRACE_ID`, `~/.codex/`, `~/.gemini/`, etc.) and **skips installing subagents** unless you pass `--scope=user|project` explicitly. Cursor, Codex, Gemini, and Cline users get all 22 MCP tools + PreToolUse hooks without the `tp-*` agents.
