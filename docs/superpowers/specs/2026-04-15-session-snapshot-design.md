# session_snapshot — MCP Tool Design

**Date:** 2026-04-15
**Issue:** TP-bot
**Status:** Approved

## Summary

New MCP tool `session_snapshot` that accepts key session facts from the AI model and returns a compact structured markdown block. Stateless formatter — no internal state tracking.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `goal` | string | yes | Session goal — what and why |
| `confirmed` | string[] | no | Established facts |
| `files` | string[] | no | Relevant file paths |
| `blocked` | string | no | Current blocker |
| `next` | string | no | Next step |

## Output Format

Structured markdown. Empty fields are omitted. Target: <200 tokens.

```markdown
## Session State
**Goal:** fix payment error in cart flow
**Confirmed:**
- backend returns 422
- frontend handles error differently
**Files:** usePaymentProcess.ts, apiCartBookingPay.ts
**Blocked:** need access to staging logs
**Next:** compare error normalization path
```

## Implementation

- New handler: `src/handlers/session-snapshot.ts`
- Register in `src/server.ts` alongside existing tools
- Tool name: `session_snapshot`
- No dependencies, no state, no file I/O

## When to Call

Model calls this tool:
- Before context compaction
- When switching direction mid-session
- On user request ("save state", "snapshot")
- Periodically in long sessions
