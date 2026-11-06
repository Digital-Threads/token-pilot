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
npx token-pilot uninstall-agents --scope=user      # ~/.claude/agents
npx token-pilot uninstall-agents --scope=project   # ./.claude/agents
```

Only files that carry `token_pilot_body_hash` are removed. Your own agents stay.

`install-agents`, `bless-agents` and `unbless-agents` still exist as commands, but
they only print a short message and exit with code 1.
