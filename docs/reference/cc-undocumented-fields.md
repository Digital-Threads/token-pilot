# Claude Code undocumented fields — support reference

**Last verified:** 2026-06 against `~/.local/share/claude/versions/2.1.131`
(Mach-O bundle, `strings` inspection).

## Why this file exists

token-pilot relies on several Claude Code hook + agent fields that are
not in the public docs (surfaced by the May 2026 Habr reverse-
engineering write-up). v0.34.0 shipped one such field (`args: string[]`)
based on release notes alone and it broke every hook with silent
ENOENT — Claude Code did not expand `${CLAUDE_PLUGIN_ROOT}` inside
`args`. The lesson: **confirm a field exists in the installed CC
bundle before shipping it, and never let an unverified field ride the
same release as working hooks.**

This table is the grounded answer to "does field X actually exist in
the user's CC?" — produced by grepping the bundle, not by trusting
changelog dates (the changelog records when a field was *documented*,
which often trails when it was *implemented*).

## Support matrix (CC 2.1.131)

| Field | Surface | Present | token-pilot uses it |
|-------|---------|:-------:|---------------------|
| `additionalContext` | hook return | ✅ | pre-grep, pre-task, post-bash, session-start |
| `permissionDecision` / `permissionDecisionReason` | PreToolUse return | ✅ | pre-read, pre-edit, pre-bash, pre-grep, pre-task |
| `updatedInput` | PreToolUse return | ✅ | pre-read (`TOKEN_PILOT_HOOK_REWRITE=1`) |
| `updatedMCPToolOutput` | PostToolUse return | ✅ | not used — server-side `SessionCache` already dedups MCP reads |
| `hookSpecificOutput` | hook return wrapper | ✅ | all JSON-returning hooks |
| `sessionTitle` | SessionStart return | ✅ | session-start (`[TP] Nk saved` badge) |
| `watchPaths` | SessionStart return | ✅ | session-start (snapshot bridging) |
| `once` | hook config | ✅ | SessionStart bootstrap |
| `async` | hook config | ✅ | PostToolUse:Bash + :Task |
| `memory` | agent frontmatter | ✅ | 5 high-value tp-* agents |
| `color` | agent frontmatter | ✅ | all 25 tp-* agents |
| `requiredMcpServers` | agent frontmatter | ✅ | all 25 tp-* agents |
| `omitClaudeMd` | agent frontmatter | ✅ | tp-audit-scanner |
| `asyncRewake` | hook config | ✅ | not used — timing semantics unconfirmed; deferred |
| `parent_agent_id` | hook input | ✅ | post-task event capture |
| `criticalSystemReminder_EXPERIMENTAL` | agent frontmatter | ✅ | not used — Anthropic flags it EXPERIMENTAL |
| `initialUserMessage` | SessionStart return | ✅ | not used — too invasive (prepends to user's first message) |
| `reloadSkills` | SessionStart return | ❌ | not used — absent on 2.1.131, and our 3 skills are static |
| `continueOnBlock` | PostToolUse config | ❌ | not used — absent on 2.1.131; our post-hooks don't reject anyway |
| `MessageDisplay` | hook event | ❌ | not used — absent on 2.1.131; display-only, no token-saving role |

## Method (reproduce)

```sh
CC=~/.local/share/claude/versions/<version>
strings "$CC" | grep -c "<fieldName>"     # >0 → the parser knows the field
```

A non-zero count means the bundle's schema/parser references the
field, which is strong evidence the field is accepted. It is NOT
proof the field produces the intended behaviour — that still needs a
live observation (e.g. confirming the `[TP] Nk saved` badge actually
renders). Treat the count as "safe to ship, verify in the wild."

## Decision rule

1. Field absent from bundle → do not ship (inert; would look like
   progress while doing nothing).
2. Field present → safe to ship as **additive** (old CC ignores
   unknown keys). Keep behaviour-changing uses behind an env flag
   until observed working.
3. Re-run this grep when bumping the floor CC version or when a
   field's behaviour looks wrong in the field.
