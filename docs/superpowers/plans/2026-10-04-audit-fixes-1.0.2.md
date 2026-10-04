# Audit fixes — release 1.0.2

Date: 2026-10-04. Source: four read-only audits of token-pilot 1.0.1 (reading
tools, search/navigation tools, git/test/session tools, hooks), every finding
reproduced live against ground truth (grep, git, raw `ast-index`, the files).
Already fixed on master: `ca4eadd` (a `ref` starting with `-` was passed to git
as an option).

## Rules for every workstream

- TDD: write the test that reproduces the finding, watch it fail for the right
  reason, then fix. A finding without a failing test first is not fixed.
- One commit per finding or per tight group, message one line, English, no
  trailers of any kind (no Co-authored-by, no Claude-Session). Plain
  `git commit -m "..."`; never change git identity.
- Touch only your workstream's files. If a fix needs another workstream's file,
  note it in your report instead of editing it.
- Prefer the smallest correct fix; delete wrong code rather than layering on it.
- A tool must never present partial data as complete: when it truncates, caps,
  or lacks data (index stale, file not indexed), it says so in its output.
- Fail open in hooks: when in doubt, allow. A false block costs more than a
  missed one.
- Keep `npx tsc --noEmit`, `npx vitest run` and `npm run -s test:mod` green.

---

## W1 — symbol structure and reading tools

Files: `src/ast-index/parser.ts` (parseOutlineText, computeEndLines, mapKind
only), `src/ast-index/enricher.ts`, `src/ast-index/symbol-resolver.ts`,
`src/ast-index/regex-parser.ts`, `src/handlers/smart-read.ts`,
`src/handlers/smart-read-many.ts`, `src/handlers/read-symbol.ts`,
`src/handlers/read-symbols.ts`, `src/handlers/read-for-edit.ts`,
`src/handlers/read-range.ts`, `src/handlers/read-diff.ts`,
`src/handlers/read-section.ts`, `src/formatters/*`, `src/core/file-watcher.ts`,
markdown/csv section parsers, `src/core/validation.ts` (smart_read,
read_symbol validators only), `src/server.ts` (file cache / watcher wiring only).

1. **Symbol end lines.** `computeEndLines` sets end = next start − 1, so a
   function with nested named functions is truncated (`createServer` in
   src/server.ts reported L101-131, really L101-1557) and the next symbol's
   JSDoc/decorators/overload signatures are swallowed. Compute real ends from
   the source in `buildFileStructure`: brace languages (ts/js/tsx/jsx/mjs/cjs,
   go, rust, java, kotlin, c#, php, swift, scala, dart, c/c++) — match the
   first `{` after the declaration start, skipping strings, template literals
   (incl. `${}`), comments and regex literals; no `{` before a top-level `;` →
   end at that line. Python — indentation. Others — keep the heuristic but
   never beyond the parent. Then rebuild nesting: a symbol whose range lies
   inside another's becomes its child.
2. **Classes collapse to their header** in every language: ast-index ≥3.48
   prints members at the same indent as the class; `parseOutlineText` pops the
   class on equal indent, so classes never get children and `depth` is dead.
   Nesting must come from ranges (item 1), not indentation.
3. Leading doc comments, decorators/annotations (`@property`, `@Override`,
   `@staticmethod`) and TS overload signatures belong to the symbol they
   precede.
4. **Empty cached structures break symbol tools.** smart_read small-file
   pass-through and read_for_edit (symbol/line/section modes) cache a
   FileStructure with `symbols: []`, `language: 'unknown'`; read_symbol,
   read_symbols, read_for_edit batch and smart_read then trust it → "Symbol
   not found" for existing symbols; smart_read later shows an empty structure.
   Never cache a structure that was not built from an outline; readers must
   re-outline when the cached one has no symbols for a code file.
5. `symbol-resolver.ts`: `Class.method` must require the class (`Beta.run`
   returned `Alpha.run`; `NoSuchClass.stop` resolved); never resolve a symbol
   from another file (`!filePath ||` at ~65 let `read_symbol(nosyms.ts,
   "handleSmartRead")` print nosyms.ts lines under another file's range);
   the `start + 50` fallback must not exist — unknown end → say so. Two
   symbols with the same name → list both (or pick by kind) instead of
   silently the first.
6. **read_diff never works after an edit**: the chokidar watcher
   (server.ts ~339, file-watcher.ts ~53-58) invalidates the cache entry that
   read_diff needs as its baseline. Keep the baseline for read_diff.
7. Validators drop parameters: smart_read `scope` (nav/exports) and
   read_symbol `include_edit_context` are not returned by their validators.
   `show_imports`/`show_docs` do nothing (`enricher.ts` sets
   imports/exports `[]`; the formatter never prints docs) — implement or
   remove from the schema; exports must not be empty for scope=exports.
8. smart_read small-file pass-through counts lines only: a 1-line minified
   bundle is returned whole. Use bytes/tokens too, and respect scope/depth.
9. smart_read_many: hardcoded per-file limits cut files to ~22 lines under a
   "returned in full" header and register them as fully loaded, so later
   read_range/read_symbol answer "DEDUP: already in context" for lines never
   shown. Honour max_tokens, say when a file is truncated, register only what
   was shown, don't count failed files in BATCH.
10. read_for_edit `include_callers`: paths relative to the plugin cache and
    "none found" (`read-for-edit.ts` ~449-455: `relative(projectRoot, p)` with
    a project-relative p). Resolve against projectRoot; pass the bare symbol
    name to refs. `include_tests` misses `tests/<dir>/<name>.test.ts` and
    co-located `x.test.ts`. `include_changes` says "unchanged" for an
    untracked file.
11. Markdown: headings inside code fences (```` ``` ````/`~~~`) are not
    headings (`markdown-sections.ts` ~21); setext headings; duplicate headings
    → say which one was returned.
12. CSV: split by record, not physical line (quoted multi-line fields);
    read_for_edit rows must give an old_string that matches the file.
13. JSON/YAML sections: last key range must not include the root `}`; quoted
    YAML keys; minified JSON with no sections says so.
14. Line counts are N+1 for files ending in `\n`; read_range header echoes the
    unclamped range; compact view not re-checked against `max_tokens`;
    non-code smart_read ignores `max_tokens`; read_symbols claims "now in your
    context" when every symbol failed; POLICY "full-file reads" counter grows
    on every smart_read.
15. outline/structure: Go `package main` shown as function, structs as class,
    receivers lost; lowercase `export const` missing; `defineConfig(...)` call
    listed as symbol; `export default {}` labelled function; nested Python defs
    not indexed; outline of test files meaningless (describe/it/test blocks
    should be shown as such or the file marked as a test file).

## W2 — git, test and session tools, CLI reports

Files: `src/handlers/smart-diff.ts`, `src/handlers/smart-log.ts`,
`src/handlers/test-summary.ts`, `src/handlers/session-*.ts`,
`src/core/session-savings.ts`, `src/core/session-snapshot*.ts`,
`src/cli/*` (stats, errors, doctor, tool-audit, help), `src/core/error-log.ts`
(format only), `src/core/context-mode-detector.ts`, analytics/tool-audit.

1. smart_diff drops hunk lines starting with `--`/`++` (`smart-diff.ts`
   ~199-203 tests `startsWith('---'/'+++')` inside hunks). Track the header
   section explicitly.
2. AFFECTED SYMBOLS: change type is decided per file (241-256) → mark per
   symbol from the hunk; hunk ranges include the 3 context lines (245-251) →
   use changed lines only (`-U0` or parse); removed symbols are never
   reported (deleted files skipped, old version never outlined) → outline the
   old blob for removed lines; commit/branch scopes outline the working-tree
   file, not the file at that commit (100-101) → outline `git show ref:path`.
3. Merge commits show "NO CHANGES" → `--diff-merges=first-parent`.
4. Wrong messages: any `fatal:` reported as "Not a git repository" (66);
   empty staged/commit/branch/path result says "working tree is clean" (77);
   untracked files never shown yet "clean" claimed; path filter on a renamed
   file's old name reports [DELETED].
5. Paths with spaces / non-ASCII break (165) → use `-z` / `core.quotePath=false`.
6. Large diffs: AFFECTED SYMBOLS unbounded (329 lines), only 10 of 50 files
   listed, contradictory "108 more" vs "50 of 118", "(42 lines changed)"
   counts context lines. One cap, one honest note.
7. Small diffs can exceed the raw diff in tokens → return raw when cheaper.
8. smart_log: "Merge pull request #… fix-typo" categorised fix → merges get
   their own category; AUTHORS stops at 5 with no "+N more".
9. test_summary: vitest counts wrong whenever "todo" appears (147) — passing
   run shows 0 total, failing run 1 of 5; fallback at 72-74 invents counts.
   Each failure listed twice; summary lines shown as error text; a passing run
   shows FAILURES when output contains "FAIL "/"× ". Timeouts must say
   timeout (56 ignores killed/signal). Child env inherits the MCP server's
   `CLAUDE_PLUGIN_ROOT` etc. (49) → strip token-pilot/Claude plugin vars so
   results match the terminal. Non-test commands get a PASS verdict; "No test
   files found" becomes "1 failed"; "134ms" printed as "134m". rspec/mocha
   have no parser (say so). Commands with env prefix or `&&` fail with ENOENT
   → document or run through a shell safely.
10. session_budget: `sessionId:""` returns 0 events though the description
    says empty = no filter (session-savings.ts ~39); average per event counts
    Task events that saved nothing.
11. session_snapshot: validate input types (a string `decisions` becomes one
    char per bullet); document that it writes `.token-pilot/snapshots/` and
    `latest.md`; archive names with ms resolution (two in one second collide).
12. doctor: context-mode detection only reads `.mcp.json` → also plugin
    installs (enabledPlugins / plugin cache); "Install mode: npm" for a
    plugin install run from a shell.
13. session_analytics: per-tool percent vs saved inconsistent ("~111 saved
    (-5%)"); "Top files" lists symbols and folders; same file under relative
    and absolute paths; totals are per process — label them so.
14. CLI `stats`: `--session` picks the pseudo-session "diagnostic"; totals
    include 391 diagnostic events; same file counted under several path
    spellings; `--tasks` double-counts duplicated subagent_stop events.
15. CLI `errors`: times without date; `--tail=3` rewrites "N total"; global
    log mixes projects without saying so.
16. `--help`: says 23 MCP tools (25: add call_tree, explore); lists no stats /
    errors / tool-audit; `tool-audit --help` prints the report.

## W3 — hooks (command hooks and the Claude Code mod)

Files: `src/hooks/*.ts`, `src/core/agent-matcher.ts`, `src/index.ts` (hook
cases only), `src/config/*`, `hooks/mod/*.ts`, `hooks/hooks.json`,
`templates/agents/*` (trigger phrases only), `src/core/mcp-path.ts`,
`src/core/validation.ts` (resolveSafePath only), `.codex/hooks.json`,
`src/hooks/session-context.ts`.

Policy (decide-functions): block only clear, unbounded dumps of code; allow
anything bounded or piped into a bounding command (`head`, `tail -n`, `wc`,
`grep -m`, `-l`, `-c`); analyse each segment of a compound command
(`&&`, `||`, `;`, `|`) separately and only with its own arguments; honour
`TOKEN_PILOT_BYPASS=1` explicitly (env and command prefix) in every gate.

1. **Agent router hard-blocks on one-word triggers** ("design", "plan",
   "scope" in tp-refactor-planner; the built-in `Plan` agent; "execute plan
   task 3"). Hard block only when `subagent_type` is `general-purpose` or
   absent AND the match is a multi-word trigger phrase with high confidence;
   never re-route other agent types (Plan, Explore, code-analyzer, …); no
   message at all for low confidence (its suggestions are often wrong:
   "fix tests"→tp-commit-writer). Trim one-word quoted triggers from the
   templates.
2. The subagent tool guide is attached to the parent's Agent result (costs
   the parent ~100 tokens, the subagent never sees it). In the mod, append it
   to the subagent's prompt via `next({...e, prompt})`; in the command hook,
   drop it.
3. **Recursive search passes**: `grep -rn`, `-nr`, `-rni`, `--recursive`,
   `rg`, `git grep` are allowed (pre-bash.ts ~129 `-[rR]\b` misses combined
   flags); `grep -r … | head`, `grep -r -m5`, `-l` are denied. Fix both ways.
4. Compound commands falsely denied (`cat package.json && node x`,
   `git status && git diff`): per-segment analysis (165-217).
5. Dumps that pass: quoted paths (`cat "x.ts"`), `2>/dev/null`, `|| true`,
   `( … )`, env prefix (`LC_ALL=C cat`), `bash -lc`, `for … cat`,
   `tail -n +1`, `head -n -1`, `head --lines=5000`, `head -c 200000`,
   `less`, `more`, `nl`, `awk` printing all, `tac`; git `--no-pager`,
   `-C .`, `git diff HEAD`, `--cached`, `HEAD~50`, `git show` unbounded;
   `find .` unbounded. Close the ones that dump a whole code file / whole
   repo; leave `python -c`/`node -e` alone (scripts, not dumps).
6. Cheap commands blocked: `sed -n '1,20p'` on any code file (allow when the
   span ≤ threshold, like head); `find /abs/project/src` treated as `/`
   (only the filesystem root or outside-project roots count); `git diff |
   head`, `git log --max-count 5` / `-n5`; `git commit -m "find / …"` (rules
   must anchor to the command word).
7. `TOKEN_PILOT_BYPASS=1` is advertised (deny footers, session text) but
   hook-read and pre-bash never read it; the strict Edit deny tells the agent
   to "set it in the environment", which it cannot do for the hook process —
   say what the agent can actually do.
8. Config: env overrides (`TOKEN_PILOT_DENY_THRESHOLD`, adaptive vars) are
   ignored when there is no `.token-pilot.json` (config/loader.ts ~23,
   hooks/mod/host.ts configFrom); `TOKEN_PILOT_MODE=advisory` still lets the
   Read gate deny (README says everything passes).
9. Wrong tool / agent names: pre-edit.ts ~94 `mcp__token-pilot__read_for_edit`,
   pre-grep.ts ~123 `code_audit`, index.ts read rewrite `smart_read`,
   post-bash `mcp__context-mode__execute` (real: `ctx_execute`; command path
   detects context-mode only via `.mcp.json`). Session/bootstrap text says
   "no agents installed; run install-agents" for plugin installs (scan the
   plugin's agents dir; name them `token-pilot:tp-*`).
10. Command hooks take `process.cwd()` as project root (index.ts ~146-149):
    after `cd src` a big Read elsewhere passes, config and telemetry go to the
    subdir. Use `CLAUDE_PROJECT_DIR`, else the nearest `.git` ancestor; make
    hook-read, hook-edit, pre-bash and the mod agree.
11. Strict mode deadlock for code files outside the project: Edit gate denies,
    read_for_edit refuses outside paths → do not gate files outside the
    project.
12. Worktree outside the project (`../feature`): mcp-path rewrites to absolute
    paths the server rejects ("outside project root") while the note says
    files read correctly. Make resolveSafePath accept the repo's own
    worktrees (verify `git worktree list` detection) or stop rewriting.
13. Grep-tool gate false positives (`token-pilot`, `UTF-8`, `x-api-key`,
    `README`, `Error`, `--max-count`, `*.md` globs, files_with_matches /
    count / head_limit searches); advice "re-run Grep with -E" — Grep has no
    `-E`.
14. Read gate counts lines only — a 1-line 317 KB min.js passes; use bytes
    too. Extension lists differ between gates (Read misses .cjs .mts .cts;
    Bash misses .vue .svelte .sql .cc .kts) → one shared list. `cat` on a
    `.md` file was blocked as a code file.
15. Deny texts: "bounded reads pass" only true for limit ≤ threshold;
    `outline(path)` on a file errors; `read_symbol(path, name)` (param is
    `symbol`), `read_range(path, start, end)` (params `start_line`,
    `end_line`); "the Glob tool", "the Task tool", "Raw Read/Grep" don't exist
    on 2.1.289 / Codex; `-m 20` advice for grep -r is misleading (per file).
16. Test-runner hint fires on any mention (`npm install -D vitest`,
    `git commit -m "fix jest"`, heredocs).
17. Workflow env: the mod counts `LOOM_WORKFLOW_ID`, the command hook's
    `activeWorkflowId` reads `CLAUDE_WORKFLOW_ID` but not `LOOM_WORKFLOW_ID`.
18. `hook-post-task` never fires: PostToolUse matcher is `Task`, the tool is
    `Agent` (hooks.json).
19. Codex gets Claude Code session text (Task tool, tp-* agents, Read/Grep);
    `rg` ungated there.
20. Edit advice right after the agent wrote the file itself (default mode);
    post-bash ignores stderr.
21. hook-post-bash logs EAGAIN errors (stdout write); Read refused a
    line-range read as "Wasted call — unchanged" after it had served only an
    outline (the outline must not count as the file being in context).

## W4 — search, navigation and overview tools

Files: `src/ast-index/client.ts`, `src/ast-index/parser.ts` (parseImportsText,
parseModuleListText, parseTodoText, parseDeprecatedText, parseAnnotationsText,
parseAgrepText only), `src/handlers/find-usages.ts`, `find-unused.ts`,
`related-files.ts`, `code-audit.ts`, `module-info.ts`, `module-route.ts`,
`project-overview.ts`, `explore-area.ts`, `explore.ts`, `call-tree.ts`,
`outline.ts`, `src/core/architecture-fingerprint.ts`.

1. call_tree always empty: the binary ignores `--format json` for call-tree;
   parse its text (client.ts ~706-714).
2. find_usages capped at ~20 per source: `refs --limit 20` default
   (client.ts ~624), `search` gets no `--limit`; find-usages.ts never passes
   `args.limit`; scope applied after the cap. Pass limits, apply scope before
   capping, report truncation and lower confidence when capped.
3. find_usages: prefix-matched definitions (`handleFind` → handleFindUsages)
   — filter by exact name; comments counted as usages — mark or drop; kind
   filters drop CONFIDENCE because definitions are filtered before the
   check; `scope` is substring not prefix (~233); hints mention a `path=`
   parameter that does not exist; lang="js" misses .mjs/.cjs; re-exports
   (`export {…} from`) listed under USAGES not IMPORTS.
4. find_unused: 59/60 false positives (same-file calls, member calls, test-only
   use, callbacks); node_modules .d.ts results; export_only ignored.
   Cross-check each candidate (refs + word grep across the project) and drop
   anything referenced; never report node_modules.
5. related_files: paths relative to the plugin cache (related-files.ts ~164,
   176; code-audit.ts ~48) → resolve against projectRoot; `type {…}` imports
   dropped (parser.ts ~151); `.js` specifiers not mapped to `.ts`; tests never
   found (`ast-index files` does not exist, client.ts ~611) → list files
   another way; importers matched by name → match by resolved path.
6. code_audit: todo / deprecated / annotations always empty — parsers expect
   single-line output, the binary prints grouped blocks; pattern mode: wrong
   paths, counts lines not matches, silent truncation.
7. module_info: "Modules matching…" / "No modules found." parsed as modules
   (parser.ts ~236-241). module_route: misleading "run ast-index rebuild"
   reason (JSON says not_indexed); format=mermaid returns plain text.
8. **node_modules is indexed** (1,120 of 1,413 files): pollutes find_usages,
   find_unused, project_overview (MAP 31/50 dirs, PATTERNS, FRAMEWORKS "Rx").
   Exclude node_modules/dist/coverage/.git from indexing and from every
   result; MAP shows 50 of 103 dirs with no notice.
9. project_overview fingerprint cache feeds on itself
   (architecture-fingerprint.ts parses output that starts with the old
   cached block); `include=["stack"]` overwrites the cache; FILES counts
   node_modules; ENTRYPOINTS lists directories, not src/index.ts.
10. explore_area: TESTS lists every top-level tests/ file for any area and
    misses tests/<dir>/ (explore-area.ts ~352); IMPORTED BY never fills
    (refs on basenames, ~236); INTERNAL DEPS analyses only 10 files incl.
    tests and still prints the full total.
11. New/unindexed files are invisible (ast-index skips dot-dirs; watcher only
    on files already read; update every 5 min) and tools answer "No usages
    found" as if complete → detect stale index for the queried files and say
    so (or update first).
12. explore: blast radius includes callers of unrelated same-named methods
    (`Array.prototype.find`); refs attributed to nested helpers; imports
    listed as callers; empty Tests group printed.
13. outline("."): counts node_modules, dist, coverage, .git.

## Integration (main session)

Merge W1–W4 into master, resolve conflicts, full suite, `claude plugin
validate .`, live checks on 2.1.289 (+2.1.250 fallback), fresh whole-branch
review, CHANGELOG, version 1.0.2, then the user publishes.
