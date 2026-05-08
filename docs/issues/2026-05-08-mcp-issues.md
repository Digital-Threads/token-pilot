# MCP Issues — 2026-05-08

External code-review report received 2026-05-08 from a WSL setup
(Windows 11 host, Ubuntu WSL2 guest, repo accessed via UNC share
`\\wsl.localhost\ubuntu\...`). All four functional issues were
reproduced from `tp-report.txt` audit data; each is now tracked as
a beads issue and addressed in v0.33.0.

## Status overview

| # | Issue | Beads | Status | Commit |
|---|-------|-------|--------|--------|
| 1 | `project_overview` returns `C:\Windows` root | token-pilot-lpp (B8) | **FIXED** | v0.33.0 |
| 2 | `smart_log` / `smart_diff` fail on UNC paths | token-pilot-z7p (B6) + token-pilot-5jh (B7) + token-pilot-lpp (B8) | **FIXED** | v0.33.0 |
| 3 | `read_range` rejects valid `start_line` | token-pilot-5lw (B9) | **FIXED** | v0.33.0 |
| 4 | `find_usages` requires manual `init()` | token-pilot-vax (B10) | **FIXED** | v0.33.0 |
| 5 | Version mismatch 0.1.1 vs package.json 0.8.3 | — | **NOT APPLICABLE** | belongs to a different package (`epitaxy`) — token-pilot is at 0.33.0 |

## Issue 1 — `project_overview` catches `C:\Windows`

**Original report:**
> При вызове `project_overview` без аргументов на проекте, открытом из
> WSL UNC-пути (`\\wsl.localhost\ubuntu\home\shahinyanm\www\token-pilot`),
> сервер отвечает `PROJECT: Windows v0.0.0` `TYPE: unknown (no config files
> found)`.

**Root cause confirmed:** `startServer()` walked `cwd` / `INIT_CWD` /
`PWD` candidates without rejecting Windows system paths. From a WSL
launch the cwd was `C:\Windows\System32` (or `/mnt/c/Windows/...` from
the WSL view) and `git rev-parse --show-toplevel` either failed or
silently returned the Windows tree.

**Fix (v0.33.0, commit on `v0.33.0-bugfix-batch`):**
- `src/index.ts` — preferred ordering changed to
  `CLAUDE_PROJECT_DIR > INIT_CWD > PWD > cwd`. Claude Code reliably
  exports `CLAUDE_PROJECT_DIR`; nothing else is trustworthy on WSL.
- New helper `isWindowsSystemPath(candidate)` filters
  `C:\Windows\…`, `C:\Program Files\…`, `/mnt/c/windows/…`, and any
  `\\…` UNC path before the candidate reaches git-detect.
- v0.34.0 Pack 2 emits a `wsl_path_rejected` diagnostic per filtered
  candidate so we can see in `stats` how often this fires in the wild.

## Issue 2 — `smart_log` / `smart_diff` fail on UNC paths

**Original report:**
> `git log failed: ... fatal: not a git repository`
> `git diff failed: ... warning: Not a git repository.`

**Root cause confirmed:** two separate bugs amplified each other.
1. `smart_log` built `gitArgs` as
   `['log', …flags, '--', ref]` and (with a path arg) appended a second
   `'--', path` separator. Git interpreted `HEAD` as a pathspec and
   silently returned empty; with a path the double `--` made it
   reject the call.
2. Both handlers DID call `execFile('git', …, { cwd: projectRoot })`,
   so the symptom on WSL was Issue 1 leaking through: `projectRoot`
   resolved to a Windows system path, every git call in that tree
   failed.

**Fix (v0.33.0):**
- `src/handlers/smart-log.ts` — drop the leading `'--'` so the args
  are `['log', …flags, ref]` then optional `'--', args.path`.
- `smart_diff` already uses `cwd: projectRoot`; it inherits the
  Issue 1 fix automatically.

## Issue 3 — `read_range` rejects valid `start_line`

**Original report:**
> `read_range({path, start_line: 95, end_line: 240})` →
> `Required parameter "start_line" must be a positive integer.`

**Root cause confirmed:** `validateReadRangeArgs` required
`typeof === "number"`. Some MCP clients (and most non-trivial transport
shims) round-trip integer arguments through JSON or environment
variables and re-emit them as strings (`"95"`).

**Fix (v0.33.0):**
- New helper `coerceIntFromAny(value)` in `src/core/validation.ts`
  accepts numeric strings (`"95"` → `95`), rejects everything else
  (decimals, `"95abc"`, `NaN`, etc.).
- `validateReadRangeArgs` now coerces both `start_line` and `end_line`
  through it.

## Issue 4 — `find_usages` requires manual `init()`

**Original report:**
> `find_usages(...)` → `Error: ast-index not initialized. Call init() first.`

**Root cause confirmed:** `server.ts` calls `astIndex.init()` once at
startup. When that init failed silently (binary download flake, FS
permissions, postinstall didn't run), every subsequent MCP call kept
throwing `not initialized` until the user manually re-invoked
`token-pilot install-ast-index` and restarted Claude Code.

**Fix (v0.33.0):**
- `src/ast-index/client.ts` — `exec()` now lazy-retries `init()` once
  on missing `binaryPath`. On second failure surfaces a friendlier
  error message pointing at `npx token-pilot install-ast-index`.

## Issue 5 — Version mismatch 0.1.1 vs 0.8.3

**Original report:**
> Token-pilot версия: 0.1.1 (по `project_overview`), при этом
> package.json — 0.8.3 (рассогласование версий).

**Not applicable.** token-pilot is at v0.33.0 in this branch and the
sources never had `0.1.1` or `0.8.3` anywhere. The reported numbers
match a different package (`epitaxy`) — the report appears to have
captured a `project_overview` from another project alongside ours.

If similar-looking numbers reappear in a real token-pilot session,
file a fresh issue with the exact `project_overview` JSON output and
the `package.json` hash so we can trace which detector returned the
fake version.

## Verification

- 1269/1269 unit tests pass on the v0.33.0 branch
  (`npx vitest run`).
- Build clean (`npm run build` writes 25 composed agents).
- Manual repro for Issues 1-2 still requires a WSL host — added a
  diagnostic event so we can verify in real-world telemetry that the
  reject path is no longer firing on a normal Linux/macOS launch.

## How to verify post-merge

1. Pull v0.33.0 on the WSL machine.
2. `npm install -g token-pilot@latest`.
3. `token-pilot migrate-hooks` to clean stale npx-cache hook entries.
4. Restart Claude Code on the affected project.
5. Confirm:
   - `project_overview()` returns the WSL path, not `C:\Windows`.
   - `smart_log()` returns commits.
   - `read_range({ path, start_line: 95, end_line: 240 })` works.
   - `find_usages("Foo")` succeeds even on a fresh shell.
   - `token-pilot doctor` shows zero stale hook entries and the
     correct cwd.
