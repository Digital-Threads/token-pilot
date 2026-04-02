# Token Savings Improvements — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Scope:** 7 changes across handlers, server.ts, tool-definitions, and config

## Problem

Token Pilot saves 30-50% on typical sessions, but analysis from the AI's perspective reveals systematic waste patterns:

1. **Double-read pattern:** `read_symbol` → `read_for_edit` reads the same symbol twice (different format)
2. **Expensive post-edit verification:** After editing, AI re-reads the whole file (~350 tokens) instead of checking just the diff (~40 tokens)
3. **Verbose navigation reads:** `smart_read` returns full type signatures when AI only needs symbol names + locations
4. **No batch dedup:** `smart_read_many` re-sends full outlines for files already in context
5. **No behavioral steering:** Tool responses don't suggest cheaper follow-up actions
6. **Late dedup check:** Handler runs full I/O before discovering file is unchanged in context
7. **Fat search results:** `find_usages` returns full context when AI often just needs a file list first

## Design Constraint

**Quality and speed must not degrade.** All new behaviors are either:
- Opt-in parameters (default unchanged)
- Config-gated features (disable if unwanted)
- Transparent optimizations (same output, less work)

---

## Change 1: `read_symbol` — `include_edit_context` parameter

### What
Add optional `include_edit_context: boolean` (default: `false`) to `read_symbol`. When `true`, append an `EDIT_CONTEXT:` section with raw unformatted code suitable for `Edit` tool's `old_string`.

### Why
Eliminates the universal `read_symbol` → `read_for_edit` double-read pattern. Same file, same symbol, two calls → one call.

### Interface change
```typescript
// tool-definitions.ts — read_symbol inputSchema.properties
include_edit_context: {
  type: 'boolean',
  description: 'Append raw code block for Edit old_string (saves a read_for_edit call)',
}
```

### Output format (when enabled)
```
FILE: src/server.ts
SYMBOL: handleSmartRead (function) [L25-80] (55 lines)

  [formatted code with line numbers as today]

REFERENCES: server.ts:320

EDIT_CONTEXT (raw — copy directly as old_string):
```
[raw code without line numbers, max 60 lines per existing MAX_EDIT_LINES]
```

CONTEXT TRACKED: This symbol is now in your context.
```

### Implementation
- File: `src/handlers/read-symbol.ts`
- After building `displaySource`, if `args.include_edit_context`:
  - Extract raw lines from `source` (already available from `symbolResolver.extractSource`)
  - Strip line number formatting
  - Append as `EDIT_CONTEXT:` section
- Also update `read_symbols.ts` handler to support `include_edit_context` per-batch

### Quality impact: None
Same data, additive section. Default `false` — existing behavior unchanged.

### Speed impact: None
Code already in memory. Zero additional I/O.

### Expected savings: 150-200 tokens per edit cycle

---

## Change 2: `smart_read` — auto-delta after recent edit

### What
When `smart_read` is called on a file that:
- Was previously loaded into context (contextRegistry has entry)
- Has changed since last load (hash differs)
- Was loaded recently (< 120 seconds ago)

Return a **delta response** instead of full outline:
- Changed/new symbols: full signature + line range
- Removed symbols: listed by name
- Unchanged symbols: compact list (name + lines only, no types)

### Why
Post-edit verification is the second most common `smart_read` use case. Full outline wastes ~300 tokens when AI only needs to see what changed.

### Interface
No new parameters. Behavior is automatic but config-gated:
```typescript
// types.ts — TokenPilotConfig.smartRead
autoDelta: {
  enabled: boolean;       // default: true
  maxAgeSec: number;      // default: 120 — only trigger if previous load was recent
}
```

### Output format (when auto-delta triggers)
```
FILE: src/server.ts (DELTA — 2 symbols changed since last read 45s ago)

CHANGED:
  function handleSmartRead [L25-82] (was L25-80) — 2 lines added
    async handleSmartRead(args: SmartReadArgs, ...): Promise<...>

UNCHANGED (12 symbols):
  function startServer [L5-22]
  class SessionAnalytics [L85-260]
  ... (10 more — use read_symbol for details)

HINT: For full re-read: smart_read("src/server.ts", scope="full")
```

### Implementation
- File: `src/handlers/smart-read.ts`
- Between step 5 (advisory context check) and step 6 (format output):
  - If `config.smartRead.autoDelta.enabled` AND `previouslyLoaded` AND `contextRegistry.isStale(absPath, cached.hash)` AND `(Date.now() - entry.loadedAt) < maxAgeSec * 1000`:
    - Compare previous structure symbols (from contextRegistry metadata) with current `cached.structure.symbols`
    - Format delta output
    - Track new symbols in contextRegistry
    - Return early

- Need to store previous symbol list in contextRegistry or derive from loaded regions

### Quality protection
- Full symbol list always included (compact form) — AI can drill down
- `scope="full"` hint provided to force full re-read if needed
- Config gate: `autoDelta.enabled: false` disables entirely

### Speed impact: Faster (less formatting, less output)

### Expected savings: 250-350 tokens per post-edit read

---

## Change 3: `smart_read` — `scope` parameter

### What
Add optional `scope` parameter to `smart_read`:
- `"full"` (default) — current behavior, full outline with types/imports/docs
- `"nav"` — compact: only symbol names + line ranges, no types/imports/docs
- `"exports"` — only exported symbols, full signatures

### Why
60-70% of `smart_read` calls are navigation (finding which file has what). Full type signatures waste tokens when AI just needs to know "function X exists at line Y".

### Interface change
```typescript
// tool-definitions.ts — smart_read inputSchema.properties
scope: {
  type: 'string',
  enum: ['full', 'nav', 'exports'],
  description: 'Output scope: full (default, all details), nav (names + lines only, 2-3x smaller), exports (public API only)',
}
```

### Output format — `scope: "nav"`
```
FILE: src/server.ts (350 lines, nav mode)

SYMBOLS:
  startServer() [L5-22]
  SessionAnalytics [L85-260]
    .record() [L100-115]
    .report() [L120-260]
  handleSmartRead() [L25-80]
  ... (8 more)

HINT: Use scope="full" for type signatures and imports.
```

### Output format — `scope: "exports"`
```
FILE: src/server.ts (350 lines, exports only)

EXPORTS:
  function startServer(config: TokenPilotConfig): Promise<void> [L5-22]
  class SessionAnalytics [L85-260]

HINT: 15 non-exported symbols hidden. Use scope="full" for all.
```

### Implementation
- File: `src/formatters/structure.ts` — add `scope` to `FormatOptions`
- `scope: "nav"`: skip imports, skip type annotations in signatures, skip docs, skip decorators. Format: `{indent}{name}() [L{start}-{end}]`
- `scope: "exports"`: filter `structure.symbols` to those in `structure.exports`, then format normally
- File: `src/handlers/smart-read.ts` — pass `args.scope` to `formatOutline`

### Quality protection
Default is `"full"` — nothing changes unless explicitly requested.

### Speed impact: Faster for nav/exports (less formatting)

### Expected savings: 150-250 tokens per navigation read

---

## Change 4: `smart_read_many` — per-file dedup

### What
Before processing each file in `smart_read_many`, check `contextRegistry`. If file is already loaded and unchanged (hash matches), return compact reminder instead of full outline.

### Why
Batch reads commonly include files already in context. Re-sending their full outlines wastes tokens.

### Implementation
- File: `src/handlers/smart-read-many.ts`
- For each path in the batch:
  - Check `contextRegistry.hasAnyLoaded(absPath)` AND `!contextRegistry.isStale(absPath, currentHash)`
  - If true: use `contextRegistry.compactReminder(absPath, symbols)` instead of full `handleSmartRead`
  - Append `"For full re-read: smart_read(\"${path}\")"` to reminder

### Quality protection
Compact reminder includes symbol list with line ranges. Full re-read always available via `smart_read` on individual file.

### Speed impact: Faster (skips file processing for cached files)

### Expected savings: 30-50% of batch token cost when files overlap with context

---

## Change 5: Dynamic actionable hints

### What
Add context-aware hints to tool responses that steer AI toward cheaper follow-up actions. Concise, specific, actionable.

### Hints to add

| After tool | Condition | Hint |
|-----------|-----------|------|
| `read_for_edit` | always | `AFTER EDIT: Use read_diff("${path}") to verify (90% cheaper than smart_read).` |
| `read_symbol` | file not fully loaded | `MORE SYMBOLS: Use smart_read("${path}", scope="nav") to see all symbols in this file.` |
| `smart_read` | file already in context, unchanged | `UNCHANGED: This file hasn't changed. Use read_symbol() for specific parts.` |
| `smart_read` | auto-delta triggered | `FULL VIEW: smart_read("${path}", scope="full") for complete outline.` |
| `find_usages` | >20 results | `NARROW: Use find_usages("${symbol}", path="specific_dir/") to filter by location.` |

### Implementation
- Each handler appends hint string based on conditions
- Config gate: `display.actionableHints: boolean` (default: `true`)
- Hints are ~20-30 tokens each — net positive because they prevent 200-400 token follow-up calls

### Quality impact: Positive (better guidance)

### Speed impact: Negligible (+20-30 tokens per response, prevents expensive follow-ups)

---

## Change 6: Early dedup check in server.ts

### What
Before dispatching to handler, check `contextRegistry` + `fileCache` for unchanged file. If file is unchanged and already in context, return compact reminder directly from server.ts without running the handler.

### Why
Currently the handler runs (reads file, parses AST, formats) before discovering the file is unchanged. Moving the check earlier saves I/O and CPU.

### Implementation
- File: `src/server.ts` — in the `smart_read` and `read_symbol` cases
- Before calling `handleSmartRead` / `handleReadSymbol`:
  ```typescript
  const absPath = resolveSafePath(projectRoot, args.path);
  const cachedFile = fileCache.get(absPath);
  if (cachedFile && !await fileCache.isStale(absPath)) {
    const hash = cachedFile.hash;
    if (contextRegistry.hasAnyLoaded(absPath) && !contextRegistry.isStale(absPath, hash)) {
      // For smart_read: return compact reminder
      // For read_symbol: return symbol reminder if symbol loaded
      // Record as cache hit in analytics
    }
  }
  ```

### Applies to
- `smart_read` — full file dedup
- `read_symbol` — per-symbol dedup (only if exact symbol already loaded)
- `read_symbols` — per-symbol dedup for each in batch

### Does NOT apply to
- `read_for_edit` — always returns raw code, edits require fresh data
- `read_range` — arbitrary ranges, dedup not reliable
- `smart_read_many` — handled in Change 4 inside the handler

### Quality impact: None (same reminder as current handler-level dedup)

### Speed impact: Faster (handler not invoked)

---

## Change 7: `find_usages` — `mode` parameter

### What
Add optional `mode` parameter:
- `"full"` (default) — current behavior with context lines
- `"list"` — returns only `file:line:symbol_kind` per match, no context

### Why
Initial discovery phase ("where is X used?") needs the file list, not context. Context is useful for drill-down (which can use `read_symbol` on specific matches).

### Interface change
```typescript
// tool-definitions.ts — find_usages inputSchema.properties
mode: {
  type: 'string',
  enum: ['full', 'list'],
  description: 'Output mode: full (with context, default), list (file:line only, 5-10x smaller)',
}
```

### Output format — `mode: "list"`
```
USAGES OF "logger" (47 matches in 12 files):

src/server.ts: L15, L89, L120, L205, L310
src/handlers/smart-read.ts: L45, L78
src/handlers/find-usages.ts: L23, L56, L112
src/core/session-analytics.ts: L8, L45
... (8 more files)

HINT: Use find_usages("logger", path="src/handlers/") to narrow, or read_symbol() on specific matches.
```

### Implementation
- File: `src/handlers/find-usages.ts`
- When `mode === "list"`: skip `renderSectionWithContext`, format as `file: L1, L2, L3`
- Group by file for readability

### Quality protection
Default `"full"` unchanged. `"list"` explicitly opted into.

### Speed impact: Much faster for list mode (no file reading for context)

### Expected savings: 70-90% reduction on initial search queries

---

## Config additions

```typescript
// types.ts — TokenPilotConfig additions
interface TokenPilotConfig {
  smartRead: {
    // ... existing
    autoDelta: {
      enabled: boolean;    // default: true
      maxAgeSec: number;   // default: 120
    };
  };
  display: {
    // ... existing
    actionableHints: boolean;  // default: true
  };
}
```

## Migration

All changes are backward-compatible:
- New parameters have defaults matching current behavior
- New config fields default to enabled (opt-out, not opt-in)
- No breaking changes to tool schemas
- No changes to existing response formats unless new parameters are used

## Testing strategy

Each change needs:
1. Unit test for new parameter/behavior
2. Test that default behavior is unchanged (regression)
3. Test for edge cases (empty file, file not in cache, stale file)

Specific tests:
- Change 1: `read_symbol` with `include_edit_context: true` returns EDIT_CONTEXT section
- Change 2: `smart_read` returns delta when file recently changed in context
- Change 2: `smart_read` returns full outline when file NOT in context (no regression)
- Change 3: `smart_read` with `scope="nav"` returns compact format
- Change 3: `smart_read` with `scope="exports"` returns only exports
- Change 4: `smart_read_many` returns reminder for cached files, full for new
- Change 6: server.ts early dedup returns reminder without invoking handler
- Change 7: `find_usages` with `mode="list"` returns file:line format

## Estimated total impact

Cumulative savings on top of current 30-50% baseline:
- **Best case (heavy edit session):** +40-60% additional savings
- **Typical mixed session:** +25-40% additional savings
- **Read-only exploration:** +15-25% additional savings
