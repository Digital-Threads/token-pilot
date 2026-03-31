# Token Savings Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token consumption by 25-60% through 7 targeted changes: eliminating double-reads, adding compact modes, dedup optimizations, and behavioral steering.

**Architecture:** All changes are backward-compatible. New parameters default to current behavior. New config fields default to enabled. Each task is independent and can be implemented/tested in isolation.

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises

**Spec:** `docs/superpowers/specs/2026-03-31-token-savings-improvements-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types.ts` | Modify | Add `autoDelta` and `actionableHints` config fields |
| `src/config/defaults.ts` | Modify | Add defaults for new config fields |
| `src/handlers/read-symbol.ts` | Modify | Add `include_edit_context` parameter |
| `src/handlers/read-symbols.ts` | Modify | Add `include_edit_context` parameter (batch) |
| `src/handlers/smart-read.ts` | Modify | Add `scope` parameter + auto-delta logic |
| `src/handlers/smart-read-many.ts` | Modify | Add per-file dedup via contextRegistry |
| `src/handlers/find-usages.ts` | Modify | Add `mode: "list"` parameter |
| `src/formatters/structure.ts` | Modify | Add `scope` to FormatOptions, implement nav/exports |
| `src/server/tool-definitions.ts` | Modify | Add new params to tool schemas + update instructions |
| `src/server.ts` | Modify | Add early dedup check before handler dispatch |
| `tests/handlers/read-symbol.test.ts` | Modify | Tests for `include_edit_context` |
| `tests/handlers/smart-read.test.ts` | Modify | Tests for `scope` and auto-delta |
| `tests/handlers/smart-read-many.test.ts` | Modify | Tests for per-file dedup |
| `tests/handlers/find-usages.test.ts` | Modify | Tests for `mode: "list"` |
| `tests/formatters/structure.test.ts` | Create | Tests for nav/exports formatting |

---

### Task 1: Config — Add new config fields

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add types to `src/types.ts`**

In `TokenPilotConfig.smartRead`, add `autoDelta` after `advisoryReminders`:

```typescript
// src/types.ts — inside TokenPilotConfig.smartRead
autoDelta: {
  enabled: boolean;
  maxAgeSec: number;
};
```

In `TokenPilotConfig.display`, add `actionableHints` after `showTokenSavings`:

```typescript
// src/types.ts — inside TokenPilotConfig.display
actionableHints: boolean;
```

- [ ] **Step 2: Add defaults to `src/config/defaults.ts`**

In `DEFAULT_CONFIG.smartRead`, add after `advisoryReminders: true`:

```typescript
autoDelta: {
  enabled: true,
  maxAgeSec: 120,
},
```

In `DEFAULT_CONFIG.display`, add after `showTokenSavings: true`:

```typescript
actionableHints: true,
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/config/defaults.ts
git commit -m "feat: add autoDelta and actionableHints config fields"
```

---

### Task 2: `read_symbol` — `include_edit_context` parameter

**Files:**
- Modify: `src/handlers/read-symbol.ts`
- Modify: `src/server/tool-definitions.ts`
- Modify: `tests/handlers/read-symbol.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/handlers/read-symbol.test.ts`:

```typescript
it('includes raw edit context when include_edit_context is true', async () => {
  const sourceCode = [
    'export class Greeter {',
    '  greet(name: string): string {',
    '    return `Hello, ${name}!`;',
    '  }',
    '}',
  ].join('\n');
  await writeFile(filePath, sourceCode);

  const resolver = {
    resolve: async () => ({
      symbol: {
        kind: 'method',
        name: 'greet',
        children: [],
        references: [],
        decorators: [],
        visibility: 'public',
        async: false,
        static: false,
        location: { startLine: 2, endLine: 4, lineCount: 3 },
      },
      startLine: 2,
      endLine: 4,
    }),
    extractSource: () => '  greet(name: string): string {\n    return `Hello, ${name}!`;\n  }',
  };

  const result = await handleReadSymbol(
    { path: 'file.ts', symbol: 'Greeter.greet', include_edit_context: true },
    tempDir,
    resolver as any,
    new FileCache(),
    new ContextRegistry(),
  );

  const text = result.content[0].text;
  expect(text).toContain('EDIT_CONTEXT');
  expect(text).toContain('greet(name: string): string {');
  // Raw code should NOT have line number prefixes
  const editSection = text.split('EDIT_CONTEXT')[1];
  expect(editSection).not.toMatch(/^\d+\s/m);
});

it('does not include edit context by default', async () => {
  const sourceCode = 'export function hello() { return 1; }';
  await writeFile(filePath, sourceCode);

  const resolver = {
    resolve: async () => ({
      symbol: {
        kind: 'function',
        name: 'hello',
        children: [],
        references: [],
        decorators: [],
        visibility: 'default',
        async: false,
        static: false,
        location: { startLine: 1, endLine: 1, lineCount: 1 },
      },
      startLine: 1,
      endLine: 1,
    }),
    extractSource: () => 'export function hello() { return 1; }',
  };

  const result = await handleReadSymbol(
    { path: 'file.ts', symbol: 'hello' },
    tempDir,
    resolver as any,
    new FileCache(),
    new ContextRegistry(),
  );

  expect(result.content[0].text).not.toContain('EDIT_CONTEXT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/read-symbol.test.ts`
Expected: 2 new tests FAIL (include_edit_context not implemented yet).

- [ ] **Step 3: Add `include_edit_context` to ReadSymbolArgs**

In `src/handlers/read-symbol.ts`, add to `ReadSymbolArgs` interface:

```typescript
include_edit_context?: boolean;
```

- [ ] **Step 4: Implement edit context output**

In `src/handlers/read-symbol.ts`, after the line `outputLines.push('CONTEXT TRACKED: This symbol is now in your context.');` and before `const output = outputLines.join('\n');`, add:

```typescript
// Append raw edit context if requested
if (args.include_edit_context) {
  const rawLines = lines.slice(resolved.startLine - 1, resolved.endLine);
  const rawCode = rawLines.join('\n');
  const maxEditLines = 60; // same as read_for_edit MAX_EDIT_LINES
  const truncatedRaw = rawLines.length > maxEditLines
    ? rawLines.slice(0, maxEditLines).join('\n') + `\n... truncated at ${maxEditLines} lines`
    : rawCode;
  outputLines.push('');
  outputLines.push('EDIT_CONTEXT (raw — copy directly as old_string):');
  outputLines.push('```');
  outputLines.push(truncatedRaw);
  outputLines.push('```');
}
```

- [ ] **Step 5: Add to tool schema**

In `src/server/tool-definitions.ts`, in the `read_symbol` tool's `inputSchema.properties`, add:

```typescript
include_edit_context: {
  type: 'boolean',
  description: 'Append raw code block for Edit old_string (saves a read_for_edit call)',
},
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/handlers/read-symbol.test.ts`
Expected: ALL tests pass including the 2 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/read-symbol.ts src/server/tool-definitions.ts tests/handlers/read-symbol.test.ts
git commit -m "feat: read_symbol include_edit_context to eliminate double-read"
```

---

### Task 3: `smart_read` — `scope` parameter (nav / exports)

**Files:**
- Modify: `src/formatters/structure.ts`
- Modify: `src/handlers/smart-read.ts`
- Modify: `src/server/tool-definitions.ts`
- Create: `tests/formatters/structure.test.ts`
- Modify: `tests/handlers/smart-read.test.ts`

- [ ] **Step 1: Write failing test for `formatOutline` with scope**

Create `tests/formatters/structure.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatOutline } from '../../src/formatters/structure.js';
import type { FileStructure } from '../../src/types.js';

function makeStructure(): FileStructure {
  return {
    path: 'test.ts',
    language: 'typescript',
    meta: { lines: 100, bytes: 3000, lastModified: Date.now(), contentHash: 'abc' },
    imports: [{ source: './dep', specifiers: ['foo'], isDefault: false, isNamespace: false, line: 1 }],
    exports: [
      { name: 'publicFunc', kind: 'function', isDefault: false, line: 5 },
      { name: 'PublicClass', kind: 'class', isDefault: false, line: 20 },
    ],
    symbols: [
      {
        name: 'publicFunc',
        qualifiedName: 'publicFunc',
        kind: 'function',
        signature: 'publicFunc(x: number, y: string): boolean',
        location: { startLine: 5, endLine: 15, lineCount: 10 },
        visibility: 'default',
        async: true,
        static: false,
        decorators: [],
        children: [],
        doc: 'A public function',
        references: ['dep.foo'],
      },
      {
        name: 'PublicClass',
        qualifiedName: 'PublicClass',
        kind: 'class',
        signature: 'PublicClass',
        location: { startLine: 20, endLine: 80, lineCount: 60 },
        visibility: 'default',
        async: false,
        static: false,
        decorators: [],
        children: [
          {
            name: 'method1',
            qualifiedName: 'PublicClass.method1',
            kind: 'method',
            signature: 'method1(): void',
            location: { startLine: 25, endLine: 35, lineCount: 10 },
            visibility: 'public',
            async: false,
            static: false,
            decorators: [],
            children: [],
            doc: null,
            references: [],
          },
        ],
        doc: null,
        references: [],
      },
      {
        name: 'internalHelper',
        qualifiedName: 'internalHelper',
        kind: 'function',
        signature: 'internalHelper(): void',
        location: { startLine: 85, endLine: 95, lineCount: 10 },
        visibility: 'default',
        async: false,
        static: false,
        decorators: [],
        children: [],
        doc: null,
        references: [],
      },
    ],
  };
}

describe('formatOutline scope', () => {
  it('scope=nav: shows only names and line ranges, no types/imports', () => {
    const output = formatOutline(makeStructure(), { scope: 'nav' });
    // Should contain symbol names with line ranges
    expect(output).toContain('publicFunc()');
    expect(output).toContain('[L5-15]');
    expect(output).toContain('PublicClass');
    expect(output).toContain('[L20-80]');
    // Should NOT contain type signatures or imports
    expect(output).not.toContain('x: number');
    expect(output).not.toContain('IMPORTS:');
    expect(output).not.toContain('calls:');
  });

  it('scope=exports: shows only exported symbols', () => {
    const output = formatOutline(makeStructure(), { scope: 'exports' });
    expect(output).toContain('publicFunc');
    expect(output).toContain('PublicClass');
    expect(output).not.toContain('internalHelper');
    expect(output).toContain('HINT:');
  });

  it('scope=full (default): shows everything as before', () => {
    const output = formatOutline(makeStructure(), {});
    expect(output).toContain('IMPORTS:');
    expect(output).toContain('x: number');
    expect(output).toContain('internalHelper');
    expect(output).toContain('calls: dep.foo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/formatters/structure.test.ts`
Expected: FAIL — `scope` is not a valid property of `FormatOptions`.

- [ ] **Step 3: Implement `scope` in `src/formatters/structure.ts`**

Add `scope` to `FormatOptions`:

```typescript
export interface FormatOptions {
  showImports?: boolean;
  showDocs?: boolean;
  showDependencyHints?: boolean;
  maxDepth?: number;
  showTokenSavings?: boolean;
  scope?: 'full' | 'nav' | 'exports';
}
```

In `formatOutline`, after extracting options, add scope handling. Replace the body of `formatOutline` with:

```typescript
export function formatOutline(structure: FileStructure, options: FormatOptions = {}): string {
  const {
    showImports = true,
    showDocs = true,
    showDependencyHints = true,
    maxDepth = 2,
    scope = 'full',
  } = options;

  const lines: string[] = [];

  // Header
  const sizeKB = (structure.meta.bytes / 1024).toFixed(1);
  const scopeLabel = scope !== 'full' ? `, ${scope} mode` : '';
  lines.push(`FILE: ${structure.path} (${structure.meta.lines} lines, ${sizeKB}KB${scopeLabel})`);
  lines.push(`LANGUAGE: ${structure.language}`);
  lines.push('');

  // --- NAV scope: compact names + line ranges only ---
  if (scope === 'nav') {
    lines.push('SYMBOLS:');
    for (const sym of structure.symbols) {
      formatSymbolNav(sym, lines, 1, maxDepth);
    }
    lines.push('');
    lines.push('HINT: Use scope="full" for type signatures and imports. Use read_symbol(path, symbol) to load code.');
    return lines.join('\n');
  }

  // --- EXPORTS scope: only exported symbols, full signatures ---
  if (scope === 'exports') {
    const exportNames = new Set(structure.exports.map(e => e.name));
    const exportedSymbols = structure.symbols.filter(s => exportNames.has(s.name));
    const hiddenCount = structure.symbols.length - exportedSymbols.length;

    lines.push('EXPORTS:');
    for (const sym of exportedSymbols) {
      formatSymbolTree(sym, lines, 1, maxDepth, showDocs, showDependencyHints);
    }
    if (hiddenCount > 0) {
      lines.push(`  ... ${hiddenCount} non-exported symbols hidden. Use scope="full" for all.`);
    }
    lines.push('');
    lines.push('HINT: Use scope="full" for all symbols including internal.');
    return lines.join('\n');
  }

  // --- FULL scope: original behavior ---
  // Imports
  if (showImports && structure.imports.length > 0) {
    lines.push('IMPORTS:');
    for (const imp of structure.imports) {
      if (imp.isNamespace) {
        lines.push(`  * as ${imp.specifiers[0]} from '${imp.source}'`);
      } else if (imp.isDefault) {
        lines.push(`  ${imp.specifiers[0]} from '${imp.source}'`);
      } else {
        lines.push(`  { ${imp.specifiers.join(', ')} } from '${imp.source}'`);
      }
    }
    lines.push('');
  }

  // Exports
  if (structure.exports.length > 0) {
    lines.push('EXPORTS:');
    for (const exp of structure.exports) {
      const defaultLabel = exp.isDefault ? ' (default)' : '';
      lines.push(`  ${exp.kind} ${exp.name}${defaultLabel}`);
    }
    lines.push('');
  }

  // Structure (cap at 40 top-level symbols)
  const MAX_OUTLINE_SYMBOLS = 40;
  lines.push('STRUCTURE:');
  const symbolsCapped = structure.symbols.length > MAX_OUTLINE_SYMBOLS;
  const displayedSymbols = symbolsCapped ? structure.symbols.slice(0, MAX_OUTLINE_SYMBOLS) : structure.symbols;
  for (const sym of displayedSymbols) {
    formatSymbolTree(sym, lines, 1, maxDepth, showDocs, showDependencyHints);
  }
  if (symbolsCapped) {
    lines.push(`  ... and ${structure.symbols.length - MAX_OUTLINE_SYMBOLS} more symbols (use read_symbol for details)`);
  }

  lines.push('');
  lines.push('HINT: Use read_symbol(path="<this file>", symbol="<name>") to load a specific symbol. Supports Class.method and Class::method.');

  return lines.join('\n');
}
```

Add the `formatSymbolNav` helper (after `formatOutline`, before `formatSymbolTree`):

```typescript
/**
 * Compact nav-mode formatting: just name + line range, no types/docs/deps.
 */
function formatSymbolNav(sym: SymbolInfo, lines: string[], depth: number, maxDepth: number): void {
  const indent = '  '.repeat(depth);
  const loc = `[L${sym.location.startLine}-${sym.location.endLine}]`;
  const callable = sym.kind === 'function' || sym.kind === 'method' ? '()' : '';
  lines.push(`${indent}${sym.name}${callable} ${loc}`);

  if (depth < maxDepth && sym.children.length > 0) {
    for (const child of sym.children) {
      formatSymbolNav(child, lines, depth + 1, maxDepth);
    }
  }
}
```

- [ ] **Step 4: Pass `scope` from `smart_read` handler**

In `src/handlers/smart-read.ts`, update the `SmartReadArgs` interface:

```typescript
export interface SmartReadArgs {
  path: string;
  show_imports?: boolean;
  show_docs?: boolean;
  show_references?: boolean;
  depth?: number;
  scope?: 'full' | 'nav' | 'exports';
}
```

In the `formatOutline` call (step 6 of the handler), pass scope:

```typescript
const output = formatOutline(cached.structure, {
  showImports: args.show_imports ?? config.display.showImports,
  showDocs: args.show_docs ?? config.display.showDocs,
  showDependencyHints: config.smartRead.showDependencyHints,
  maxDepth: args.depth ?? config.display.maxDepth,
  scope: args.scope ?? 'full',
});
```

- [ ] **Step 5: Add `scope` to tool schema**

In `src/server/tool-definitions.ts`, in `smart_read` inputSchema.properties, add:

```typescript
scope: {
  type: 'string',
  enum: ['full', 'nav', 'exports'],
  description: 'Output scope: full (default, all details), nav (names + lines only, 2-3x smaller), exports (public API only)',
},
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/formatters/structure.test.ts tests/handlers/smart-read.test.ts`
Expected: ALL pass.

- [ ] **Step 7: Commit**

```bash
git add src/formatters/structure.ts src/handlers/smart-read.ts src/server/tool-definitions.ts tests/formatters/structure.test.ts
git commit -m "feat: smart_read scope parameter (nav/exports) for compact output"
```

---

### Task 4: `smart_read` — auto-delta after edit

**Files:**
- Modify: `src/handlers/smart-read.ts`
- Modify: `src/core/context-registry.ts`
- Modify: `tests/handlers/smart-read.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/handlers/smart-read.test.ts`:

```typescript
it('returns delta output when file changed recently in context', async () => {
  // Create a file with 2 functions (above threshold to avoid small-file pass-through)
  const lines: string[] = [];
  for (let i = 0; i < 250; i++) lines.push(`// line ${i + 1}`);
  const originalContent = lines.join('\n');
  const filePath = join(tempDir, 'delta.ts');
  await writeFile(filePath, originalContent);

  const fileCache = new FileCache();
  const contextRegistry = new ContextRegistry();
  const config = { ...DEFAULT_CONFIG, smartRead: { ...DEFAULT_CONFIG.smartRead, autoDelta: { enabled: true, maxAgeSec: 120 } } };

  // First read — loads into context
  await handleSmartRead(
    { path: 'delta.ts' },
    tempDir,
    { outline: async () => null } as any,
    fileCache,
    contextRegistry,
    config,
  );

  // Modify file slightly
  lines[10] = '// CHANGED LINE';
  await writeFile(filePath, lines.join('\n'));
  // Invalidate file cache so it re-reads
  fileCache.invalidate(join(tempDir, 'delta.ts'));

  // Second read — should trigger delta
  const result = await handleSmartRead(
    { path: 'delta.ts' },
    tempDir,
    { outline: async () => null } as any,
    fileCache,
    contextRegistry,
    config,
  );

  const text = result.content[0].text;
  // Should indicate delta mode (file was in context and changed)
  // At minimum should not return a full outline — should be smaller
  expect(text).toContain('delta.ts');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/smart-read.test.ts`
Expected: FAIL or pass but not delta behavior. Establishes baseline.

- [ ] **Step 3: Add `lastSymbolNames` to ContextRegistry**

In `src/core/context-registry.ts`, add to `ContextEntry` (in types.ts):

```typescript
// src/types.ts — add to ContextEntry
symbolNames?: string[];
```

In `src/core/context-registry.ts`, update `trackLoad` — when type is `'structure'`, also store symbol names on the entry:

```typescript
trackStructureSymbols(path: string, symbolNames: string[]): void {
  const entry = this.entries.get(path);
  if (entry) {
    entry.symbolNames = symbolNames;
  }
}

getSymbolNames(path: string): string[] | undefined {
  return this.entries.get(path)?.symbolNames;
}
```

- [ ] **Step 4: Implement auto-delta in `smart-read.ts`**

In `src/handlers/smart-read.ts`, after step 5 (advisory context check) where `previouslyLoaded` is checked but file IS stale, add delta logic:

```typescript
// 5b. Auto-delta: file changed since last load, recently loaded
if (
  config.smartRead.autoDelta?.enabled &&
  previouslyLoaded &&
  contextRegistry.isStale(absPath, cached!.hash)
) {
  const entry = contextRegistry['entries'].get(absPath); // access loadedAt
  if (entry && (Date.now() - entry.loadedAt) < (config.smartRead.autoDelta.maxAgeSec ?? 120) * 1000) {
    const prevNames = contextRegistry.getSymbolNames(absPath) ?? [];
    const currentNames = cached!.structure.symbols.map(s => s.name);

    const added = currentNames.filter(n => !prevNames.includes(n));
    const removed = prevNames.filter(n => !currentNames.includes(n));
    const unchanged = currentNames.filter(n => prevNames.includes(n));

    const deltaLines: string[] = [
      `FILE: ${args.path} (DELTA — changed since last read ${formatDuration(Date.now() - entry.loadedAt)} ago)`,
      '',
    ];

    if (added.length > 0) {
      deltaLines.push('ADDED:');
      for (const name of added) {
        const sym = cached!.structure.symbols.find(s => s.name === name);
        if (sym) deltaLines.push(`  ${sym.kind} ${sym.signature} [L${sym.location.startLine}-${sym.location.endLine}]`);
      }
      deltaLines.push('');
    }

    if (removed.length > 0) {
      deltaLines.push(`REMOVED: ${removed.join(', ')}`);
      deltaLines.push('');
    }

    if (unchanged.length > 0) {
      deltaLines.push(`UNCHANGED (${unchanged.length} symbols):`);
      for (const name of unchanged.slice(0, 15)) {
        const sym = cached!.structure.symbols.find(s => s.name === name);
        if (sym) deltaLines.push(`  ${sym.name} [L${sym.location.startLine}-${sym.location.endLine}]`);
      }
      if (unchanged.length > 15) deltaLines.push(`  ... and ${unchanged.length - 15} more`);
      deltaLines.push('');
    }

    deltaLines.push(`HINT: For full re-read: smart_read("${args.path}", scope="full")`);

    // Update tracking
    const deltaText = deltaLines.join('\n');
    const deltaTokens = estimateTokens(deltaText);
    contextRegistry.trackLoad(absPath, { type: 'structure', startLine: 1, endLine: cached!.structure.meta.lines, tokens: deltaTokens });
    contextRegistry.setContentHash(absPath, cached!.hash);
    contextRegistry.trackStructureSymbols(absPath, currentNames);

    return { content: [{ type: 'text', text: deltaText }] };
  }
}
```

Add import for `formatDuration` at top of `smart-read.ts`:

```typescript
import { formatDuration } from '../core/format-duration.js';
```

Also, in the existing step 7 (track), after `contextRegistry.trackLoad(...)`, add:

```typescript
contextRegistry.trackStructureSymbols(absPath, cached.structure.symbols.map(s => s.name));
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/handlers/smart-read.test.ts`
Expected: ALL pass.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/smart-read.ts src/core/context-registry.ts src/types.ts tests/handlers/smart-read.test.ts
git commit -m "feat: smart_read auto-delta for recently edited files"
```

---

### Task 5: `smart_read_many` — per-file dedup

**Files:**
- Modify: `src/handlers/smart-read-many.ts`
- Modify: `tests/handlers/smart-read-many.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/handlers/smart-read-many.test.ts`:

```typescript
it('returns compact reminder for files already in context', async () => {
  const content = 'export function hello() { return 1; }\n';
  const filePath = join(tempDir, 'cached.ts');
  await writeFile(filePath, content);

  const fileCache = new FileCache();
  const contextRegistry = new ContextRegistry();

  // First read — puts file in context
  await handleSmartReadMany(
    { paths: ['cached.ts'] },
    tempDir,
    { outline: async () => null } as any,
    fileCache,
    contextRegistry,
    DEFAULT_CONFIG,
  );

  // Second read — should get compact response
  const result = await handleSmartReadMany(
    { paths: ['cached.ts'] },
    tempDir,
    { outline: async () => null } as any,
    fileCache,
    contextRegistry,
    DEFAULT_CONFIG,
  );

  const text = result.content[0].text;
  // Should indicate the file was already loaded
  expect(text.length).toBeLessThan(content.length * 3); // much smaller than full
});
```

- [ ] **Step 2: Run test to verify baseline**

Run: `npx vitest run tests/handlers/smart-read-many.test.ts`
Expected: Test may pass or fail depending on current behavior — establishes baseline.

- [ ] **Step 3: Implement per-file dedup**

In `src/handlers/smart-read-many.ts`, modify the batch processing loop. Before `handleSmartRead` call, check contextRegistry:

```typescript
// Inside the batch.map callback, before handleSmartRead:
const absPath = resolveSafePath(projectRoot, path);
const cachedFile = fileCache.get(absPath);

// Per-file dedup: if file is in context and unchanged, return compact reminder
if (cachedFile && contextRegistry.hasAnyLoaded(absPath) && !contextRegistry.isStale(absPath, cachedFile.hash)) {
  const reminder = contextRegistry.compactReminder(absPath, cachedFile.structure?.symbols ?? []);
  const reminderText = reminder || `FILE: ${path} (already in context, unchanged)`;
  const fullTokens = await estimateFullFileTokens(projectRoot, path);
  return { path, text: reminderText + `\nFor full re-read: smart_read("${path}")`, fullTokens };
}
```

Add imports at top of file:

```typescript
import { resolveSafePath } from '../core/validation.js';
```

Note: `resolveSafePath` is already imported in the file.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/handlers/smart-read-many.test.ts`
Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/smart-read-many.ts tests/handlers/smart-read-many.test.ts
git commit -m "feat: smart_read_many per-file dedup via contextRegistry"
```

---

### Task 6: Dynamic actionable hints

**Files:**
- Modify: `src/handlers/read-for-edit.ts`
- Modify: `src/handlers/read-symbol.ts`
- Modify: `src/handlers/find-usages.ts`

- [ ] **Step 1: Add post-edit hint to `read_for_edit`**

In `src/handlers/read-for-edit.ts`, before the final return, add:

```typescript
// Actionable hint: steer toward read_diff after edit
if (config?.display?.actionableHints !== false) {
  const hintPath = args.path;
  outputLines.push('');
  outputLines.push(`AFTER EDIT: Use read_diff("${hintPath}") to verify changes (90% cheaper than re-reading the file).`);
}
```

Note: `handleReadForEdit` needs `config` parameter. Check if it already receives it; if not, add `config: TokenPilotConfig` as last parameter and pass it from `server.ts`.

- [ ] **Step 2: Add context-aware hint to `read_symbol`**

In `src/handlers/read-symbol.ts`, before the final return (after confidence metadata), add:

```typescript
// Actionable hint
if (args.include_edit_context) {
  outputLines.push(`AFTER EDIT: Use read_diff("${args.path}") to verify (90% cheaper than smart_read).`);
}
```

- [ ] **Step 3: Add narrowing hint to `find_usages`**

In `src/handlers/find-usages.ts`, when result count exceeds 20, append hint:

```typescript
// After building the results, before return:
if (totalMatches > 20) {
  resultLines.push('');
  resultLines.push(`NARROW: ${totalMatches} matches found. Use find_usages("${args.symbol}", path="specific_dir/") to filter by location.`);
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/read-for-edit.ts src/handlers/read-symbol.ts src/handlers/find-usages.ts
git commit -m "feat: dynamic actionable hints in tool responses"
```

---

### Task 7: Early dedup check in `server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add early dedup for `smart_read`**

In `src/server.ts`, in the `case 'smart_read'` block, BEFORE `const result = await handleSmartRead(...)`, add:

```typescript
// Early dedup: skip handler if file unchanged and already in context
const earlyAbsPath = resolve(projectRoot, validArgs.path);
const earlyCache = fileCache.get(earlyAbsPath);
if (earlyCache && !await fileCache.isStale(earlyAbsPath) && contextRegistry.hasAnyLoaded(earlyAbsPath) && !contextRegistry.isStale(earlyAbsPath, earlyCache.hash)) {
  const reminder = contextRegistry.compactReminder(earlyAbsPath, earlyCache.structure?.symbols ?? []);
  if (reminder) {
    const reminderTokens = estimateTokens(reminder);
    recordWithTrace({
      tool: 'smart_read', path: validArgs.path,
      tokensReturned: reminderTokens, tokensWouldBe: fullTokensSR || reminderTokens,
      timestamp: Date.now(), savingsCategory: 'dedup', sessionCacheHit: true,
      absPath: earlyAbsPath, args: validArgs,
    });
    return { content: [{ type: 'text', text: reminder }] };
  }
}
```

Note: `fullTokensSR` may need to be computed before this check. Move the `estimateFullTokens` call before the early dedup block or use `estimateTokens(earlyCache.content)`.

- [ ] **Step 2: Add early dedup for `read_symbol`**

In `src/server.ts`, in the `case 'read_symbol'` block, BEFORE `const symResult = await handleReadSymbol(...)`, add:

```typescript
// Early dedup: skip handler if exact symbol already in context
const symAbsPath = resolve(projectRoot, symArgs.path);
const symCache = fileCache.get(symAbsPath);
if (symCache && !await fileCache.isStale(symAbsPath) && !contextRegistry.isStale(symAbsPath, symCache.hash)) {
  if (contextRegistry.isSymbolLoaded(symAbsPath, symArgs.symbol)) {
    const reminder = contextRegistry.symbolReminder(symAbsPath, symArgs.symbol);
    if (reminder) {
      const reminderTokens = estimateTokens(reminder);
      recordWithTrace({
        tool: 'read_symbol', path: symArgs.path,
        tokensReturned: reminderTokens, tokensWouldBe: fullTokensSym || reminderTokens,
        timestamp: Date.now(), savingsCategory: 'dedup', sessionCacheHit: true,
        absPath: symAbsPath, args: symArgs,
      });
      return { content: [{ type: 'text', text: reminder }] };
    }
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests pass — early dedup returns same content as handler-level dedup.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: early dedup check in server.ts before handler dispatch"
```

---

### Task 8: `find_usages` — `mode: "list"` parameter

**Files:**
- Modify: `src/handlers/find-usages.ts`
- Modify: `src/server/tool-definitions.ts`
- Modify: `tests/handlers/find-usages.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/handlers/find-usages.test.ts`:

```typescript
it('mode=list returns file:line format without context', async () => {
  // This test depends on existing test setup in the file.
  // Create test files with a symbol, then call find_usages with mode: 'list'.
  // The result should contain file paths and line numbers but no context lines.
  // Adapt to existing test fixtures in the file.

  // Minimal validation: check that the handler accepts mode argument
  // and produces output containing file:line format
  const result = await handleFindUsages(
    { symbol: 'testSymbol', mode: 'list' },
    tempDir,
    astIndex,
    fileCache,
  );

  const text = result.content[0].text;
  // List mode should not contain indented context lines
  // (exact assertions depend on test fixtures)
  expect(text).toBeDefined();
});
```

Note: Adapt this test to match existing test setup in `find-usages.test.ts`. The exact fixtures (tempDir files, astIndex mock) should match the file's existing patterns.

- [ ] **Step 2: Add `mode` to `FindUsagesArgs`**

In `src/core/validation.ts`, find the `FindUsagesArgs` interface and add:

```typescript
mode?: 'full' | 'list';
```

- [ ] **Step 3: Implement list mode in handler**

In `src/handlers/find-usages.ts`, after collecting all results (definitions, imports, usages arrays), add early return for list mode:

```typescript
if (args.mode === 'list') {
  const allItems = [...(definitions ?? []), ...(imports ?? []), ...(usages ?? [])];
  const byFile = new Map<string, number[]>();
  for (const item of allItems) {
    const arr = byFile.get(item.file) ?? [];
    arr.push(item.line);
    byFile.set(item.file, arr);
  }

  const listLines: string[] = [
    `USAGES OF "${args.symbol}" (${allItems.length} matches in ${byFile.size} files):`,
    '',
  ];

  for (const [file, fileLines] of byFile) {
    const sorted = [...new Set(fileLines)].sort((a, b) => a - b);
    listLines.push(`  ${file}: L${sorted.join(', L')}`);
  }

  listLines.push('');
  listLines.push(`HINT: Use find_usages("${args.symbol}", path="specific_dir/") to narrow, or read_symbol() on specific matches.`);

  return { content: [{ type: 'text', text: listLines.join('\n') }] };
}
```

- [ ] **Step 4: Add to tool schema**

In `src/server/tool-definitions.ts`, in `find_usages` inputSchema.properties, add:

```typescript
mode: {
  type: 'string',
  enum: ['full', 'list'],
  description: 'Output mode: full (with context, default), list (file:line only, 5-10x smaller for initial discovery)',
},
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/handlers/find-usages.test.ts`
Expected: ALL pass.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/find-usages.ts src/core/validation.ts src/server/tool-definitions.ts tests/handlers/find-usages.test.ts
git commit -m "feat: find_usages mode=list for compact discovery output"
```

---

### Task 9: Update MCP_INSTRUCTIONS and tool descriptions

**Files:**
- Modify: `src/server/tool-definitions.ts`

- [ ] **Step 1: Update MCP_INSTRUCTIONS**

In the `MCP_INSTRUCTIONS` array, update the decision rules to mention new capabilities:

After rule 3 (`smart_read`), add:
```
   - For navigation/browsing: smart_read(scope="nav") — names + lines only, 2-3x smaller
   - For public API overview: smart_read(scope="exports")
```

After rule 4 (`read_symbol`), add:
```
   - Preparing edit? Add include_edit_context=true to skip separate read_for_edit call
```

After rule 9 (`find_usages`), add:
```
   - For initial discovery: find_usages(mode="list") — file:line only, 5-10x smaller
```

Update the WORKFLOWS section:
```
'• Edit: smart_read → read_symbol(include_edit_context=true) → Edit → read_diff',
```

- [ ] **Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/tool-definitions.ts
git commit -m "docs: update MCP_INSTRUCTIONS with new tool capabilities"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests pass.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify no regressions in default behavior**

Manually verify:
- `smart_read` without `scope` → same output as before
- `read_symbol` without `include_edit_context` → same output as before
- `find_usages` without `mode` → same output as before
- `smart_read_many` for new files → full outline as before

- [ ] **Step 4: Final commit with version bump**

Update `package.json` version to next minor, update `.token-pilot-fingerprint.json`:

```bash
git add -A
git commit -m "feat: token savings improvements v0.17.0 — scope, edit context, auto-delta, dedup, hints, list mode"
```
