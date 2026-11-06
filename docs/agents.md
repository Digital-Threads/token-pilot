# Subagents

token-pilot no longer ships subagents. The `tp-*` agents are gone, along with the
routing that sent Agent/Task dispatches to them.

Why: the MCP tools carry their own advice in their descriptions, so a separate
agent adds nothing the tools do not already say. The agents' descriptions also
cost context in every session, and they were rarely used.

## Remove copies an older version installed

An older token-pilot may have copied `tp-*.md` files into your agents folder.
Remove them with one or both of:

```bash
npx token-pilot uninstall-agents --scope=user      # $CLAUDE_CONFIG_DIR/agents, else ~/.claude/agents
npx token-pilot uninstall-agents --scope=project   # ./.claude/agents
```

Only files that carry `token_pilot_body_hash` are removed. Your own agents stay.
Each session start lists the copies it finds and the exact command to remove them.

Copies `bless-agents` made in a project are removed with
`npx token-pilot unbless-agents --all`.

`install-agents` and `bless-agents` still exist as commands, but they only print
a short message and exit with code 1.
