# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm install            # install deps
npm run build          # tsc + scripts/build-agents.mjs (composes 25 tp-* agents)
npx vitest run         # full unit suite (~1300 tests)
npx tsc --noEmit       # type-check only
```

The build step regenerates `agents/tp-*.md` from `templates/agents/`.
Never hand-edit files in `agents/` — edit the template + shared
fragments (`_shared-preamble.md`, `_response-contract.md`) and rebuild.

## Architecture Overview

- `src/index.ts` — CLI entry + every hook command (`hook-read`,
  `hook-pre-task`, `hook-post-task`, `hook-bootstrap`, …) and
  `startServer` (projectRoot detection).
- `src/server.ts` — MCP dispatcher (`createServer`). Every tool case
  goes through the `SessionCache` for cross-call dedup.
- `src/hooks/` — pure decide-functions per hook (pre-bash, pre-grep,
  pre-task, pre-edit, post-bash, post-task, session-start) + the
  `runHookEntryPoint` safe-runner.
- `src/ast-index/` — wrapper around the bundled `ast-index` binary.
- `src/core/` — event-log, error-log, validation, agent-matcher.
- `templates/agents/` → `scripts/build-agents.mjs` → `agents/`.

## Conventions & Patterns

- **Planning docs live in `docs/superpowers/plans/`; specs in
  `docs/superpowers/specs/`; design notes in `docs/design/`; ADRs in
  `docs/adr/`.** There is no `.docs/` directory — ignore any older
  reference to one.
- Hook decide-functions are pure (input → decision); the thin
  `index.ts` case does stdin read + stdout write + `process.exit(0)`.
  Telemetry writes are best-effort and must never throw out of a hook.
- Undocumented Claude Code fields: confirm presence in the installed
  CC bundle before shipping (see
  `docs/reference/cc-undocumented-fields.md`). Never let an unverified
  field ride the same release as working hooks.
