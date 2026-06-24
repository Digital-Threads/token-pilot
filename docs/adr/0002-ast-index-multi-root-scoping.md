# ADR 0002 — ast-index multi-root scoping (walk-up gate + subtree plan)

**Status:** Accepted (Decision 1, walk-up gate) / Proposed (Decision 2, subtree scoping)
**Date:** 2026-06
**Supersedes:** nothing

## Context

token-pilot wraps the third-party `@ast-index/cli` binary. It always
runs the binary with `cwd` set to the detected project root (the git
toplevel, when there is one). Two related multi-root problems sit on
top of that single-index assumption:

**(a) Cross-project index bleed.** When the detected `projectRoot` is a
non-git PARENT directory holding several sibling repos
(`work/repo-a`, `work/repo-b`, …), a single ast-index DB rooted at the
parent would mix symbols from unrelated projects. token-pilot mitigates
this today by detecting that shape (`isMultiRepoParent`,
`src/core/validation.ts`) and DISABLING ast-index for that root — search
falls back to the regex parser. Correct, but it means zero ast-index
benefit on those layouts.

**(b) Nested-worktree escape.** `exec()` in
`src/ast-index/client.ts` used to set `AST_INDEX_WALK_UP=1`
unconditionally. That flag tells the binary's read-commands to traverse
PAST nested VCS markers and reuse a parent-level index — it exists so a
bare monorepo SUBDIR (no `.git`, no local DB) can find the root index.
But forcing it on every spawn is wrong when `projectRoot` is itself a
git repo/worktree root: a git worktree nested under the main repo
(e.g. `main-repo/.worktrees/feature`) would walk up past its own `.git`
marker and escape to the MAIN repo's parent index, returning the wrong
files.

## Decision 1 — gate AST_INDEX_WALK_UP on the `.git` marker (Accepted, shipped here)

`exec()` now sets `AST_INDEX_WALK_UP=1` ONLY when `projectRoot` has no
`.git` marker of its own. The marker is computed once
(`computeHasGitMarker`, re-evaluated in `updateProjectRoot` after a
branch/root change) as `existsSync(resolve(projectRoot, ".git"))` — a
`.git` DIRECTORY (normal repo) or a `.git` FILE (worktree / submodule
gitlink) both count.

Why this is safe:

- token-pilot already sets `cwd` to the git toplevel. For a repo or
  worktree root, the binary finds the local index without walking up,
  so the flag was at best a no-op there.
- Walk-up only ever HELPED the bare-subdir case (no marker, no local
  DB) — exactly the case the gate still enables.
- For repo/worktree roots the flag's only observable effect was the
  escape bug in (b). Skipping it removes that bug without removing the
  subdir benefit.
- When a marker is present we simply refrain from FORCING the flag; a
  value the user set in the environment themselves is left untouched.

This is a behaviour fix with no config surface and no rooting-model
change. Covered by unit tests in `tests/ast-index/client.test.ts`
(marker present → flag absent; no marker → flag set; `computeHasGitMarker`
across `.git` dir / file / absence).

## Decision 2 — subtree scoping to re-enable ast-index on multi-root parents (Proposed, deferred)

Adopt ast-index 3.47's subtree model plus the `--local` / `--subtree`
query flags to RE-ENABLE ast-index on multi-repo and worktree-parent
layouts instead of disabling it:

1. Index the parent directory once.
2. Register each child project as a named subtree.
3. Scope every read query (`exec`/`search`/`usages` in
   `src/ast-index/client.ts`) with `--local` / `--subtree` so results
   never bleed across siblings.

This would let `isMultiRepoParent` roots keep ast-index instead of
falling back to regex, and would give nested worktrees a first-class
scoped index rather than relying on the walk-up gate.

Why deferred:

- It requires a rooting-model rework: how the index root is chosen, and
  the `isMultiRepoParent` → disable path
  (`src/core/validation.ts`), both have to change so the parent is
  indexed-and-scoped rather than skipped.
- `--local` is a no-op without the subtree registration step, so the
  flag alone buys nothing — the whole model has to land together.
- The Decision 1 gate already closes the correctness hole (the escape
  bug) cheaply, which removes the urgency.

## Consequences / follow-ups

- Shipped: nested worktrees and repo roots no longer escape to a parent
  index; bare subdirs keep walk-up.
- Still open: `isMultiRepoParent` roots get no ast-index benefit
  (regex-only). The subtree model in Decision 2 is the planned fix;
  file it as a tracked task before starting the rooting rework.
- If a future ast-index release changes walk-up semantics or ships the
  subtree flags, revisit both decisions here.

## Alternatives considered

- **Keep forcing `AST_INDEX_WALK_UP=1` and special-case worktrees
  elsewhere.** Rejected: the marker check is the same signal
  `isMultiRepoParent` already uses, so gating at the env-construction
  point is the smallest, most consistent change.
- **Disable ast-index for worktree roots too** (mirror the multi-repo
  parent mitigation). Rejected: a worktree root owns a perfectly good
  local index; disabling would throw away real benefit to avoid a bug
  the gate already prevents.
