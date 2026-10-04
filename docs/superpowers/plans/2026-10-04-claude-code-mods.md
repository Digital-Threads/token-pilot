# Claude Code Mods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve token-pilot's Claude Code hooks from an in-process mod. They get faster and better. Every other client and every older Claude Code keeps today's command hooks. Ships as 1.0.0.

**Architecture:** One plugin carries both a mod (`hooks/hooks.json` → `"modules"`) and the existing command hooks. At session start the mod sets `TOKEN_PILOT_MOD` to the comma list of hook actions it serves. `hooks/run.sh` exits before starting node for any action in that list. With the mod off, the flag is never set and the command hooks run as before. The decision logic stays in `src/hooks/*` as Node-free functions. The command path (`src/index.ts`) and the mod (`hooks/mod/*`) each do their own I/O and call those functions.

**Tech Stack:** TypeScript (ESM), vitest, the Claude Code mods API (`claude-code`, `claude-code/testing`), `claude plugin validate` / `claude plugin test` (Claude Code ≥ 2.1.289 in CI).

**Spec:** `docs/superpowers/specs/2026-10-04-claude-code-mods-design.md`. Read its "Verified facts" table first. Every API assumption below comes from that table.

## Global Constraints

- Mods load in Claude Code ≥ 2.1.275. They are tested on 2.1.289. Older versions must keep working through the command hooks; nothing may require a mod.
- Nothing imported by `hooks/mod/**` may import `node:*`, use a bare npm specifier, or read `process.*`. `tests/core/mod-safe.test.ts` enforces this. Add every new shared module to its `MOD_ENTRIES`.
- A mod module may register **at most one unmatched hook per event** (engine rule; a second one makes the whole mod fail to load). `session.start`, `classic.SessionStart`, `prompt.compose` and the unmatched `tool.call` therefore live once, in `hooks/mod/register.ts`, which delegates.
- `$.env.get` / `$.env.set` take **string literals** only.
- In `claude plugin test` every `$` call made by the mod needs a stub: `on('<noun>.<method>', async () => ({ value: X }) as any)`. `{ value: undefined }` is valid; `undefined`, `null` and `{}` are rejected. Raise SessionStart with `await ($ as any).classic.SessionStart({ source: 'startup' })` after `on('classic.SessionStart', async () => ({}) as any)`.
- A hook must never block a call because of its own failure. Wrap I/O in try/catch and fall through to `next(e)`.
- Codex (`src/hooks/codex-installer.ts`) and `token-pilot install-hook` (settings.json command hooks) do not change.
- Never hand-edit `agents/*.md`. They are generated from `templates/agents/` by `npm run build`.
- Commits: one line, English, no trailers. Commit after each green step. Do not push.
- UI and model-facing text is English.

## Review Focus

1. **Mod off (organisation policy, load error, Claude Code < 2.1.275).** The flag is never set, so every command hook must run exactly as in 0.53.1. Pinned by Task 4's `run.sh` tests, Task 4's live check on 2.1.250, and Task 15's matrix.
2. **Flag name collisions.** `hook-pre` or `hook-pre-bash-x` in the flag must not silence `hook-pre-bash`; matching is exact and comma-delimited. Pinned by Task 4.
3. **Windows paths.** `C:\repo\src\a.ts` and mixed separators must flow through `portable-path` and the MCP-path rewrite. Pinned by Tasks 1 and 2.
4. **Read gate inputs.** A file outside the project or symlinked out of it, a non-code file, and a bounded `offset`/`limit` read below threshold must all pass through untouched. When the smart_read call fails, the model gets today's pointer text, not an empty result. Pinned by Task 9.
5. **Subagent calls.** A subagent's Bash/Read/Edit/MCP calls go through the same mod hooks (spec fact 13). For MCP paths, whether `$.session.cwd()` reflects a subagent's own cwd is unverified. Task 7 checks it live and specifies both outcomes.

---

## File Structure

New:

| File | Responsibility |
| --- | --- |
| `src/core/portable-path.ts` | `/` and `C:\` path helpers with no `node:path` (resolve, relative, isAbsolute, dirname, join, normalize). |
| `src/core/agent-index-fs.ts` | Node `buildAgentIndex(dir)`, moved out of `agent-matcher.ts`. |
| `src/core/hook-event.ts` | Pure builders for hook-events.jsonl records (diagnostic, read-gate, task). |
| `src/hooks/find-checkout.ts` | Node `findCheckout(dir)`, moved out of `mcp-path.ts`. |
| `src/hooks/agent-budget.ts` | `parseAgentBudget`, `decideBudgetAdvice`, moved out of `post-task.ts`. |
| `src/hooks/session-context.ts` | Reminder text builders, moved out of `session-start.ts`. |
| `src/hooks/read-gate.ts` | `CODE_EXTENSIONS`, `isCodeFile`, `effectiveReadSpanLines` (moved out of `index.ts`), `decideReadGate`, `outlineHeader`. |
| `src/config/resolve.ts` | Pure `resolveConfig(userConfig, env, warn)`, split out of `loader.ts`. |
| `hooks/mod/register.ts` | The mod entry. Owns every unmatched hook and the `SERVED` list. |
| `hooks/mod/host.ts` | `$` helpers: config, telemetry append, checkout lookup, agent files. |
| `hooks/mod/bash.ts`, `grep.ts`, `mcp.ts`, `edit.ts`, `read.ts`, `agent.ts`, `session.ts`, `status.ts`, `stats.tsx` | One handler group each. |
| `hooks/mod/*.test.ts` | `claude plugin test` suites. |
| `scripts/test-mod.mjs` | Stages the plugin without `tests/` and runs `claude plugin validate` + `claude plugin test`. Fails on 0 passes. |
| `tests/core/mod-safe.test.ts` | Guard: no Node on the mod's import graph. |
| `tests/hooks/run-sh.test.ts` | Hand-off behaviour of `hooks/run.sh`. |

Modified: `src/core/tool-names.ts`, `src/server/enforcement-mode.ts`, `src/hooks/mcp-path.ts`, `src/hooks/hook-mcp-path.ts`, `src/core/agent-matcher.ts`, `src/hooks/pre-task.ts`, `src/hooks/post-task.ts`, `src/hooks/session-start.ts`, `src/config/loader.ts`, `src/core/event-log.ts`, `src/index.ts`, `hooks/hooks.json`, `hooks/run.sh`, `package.json`, `.github/workflows/ci.yml`, docs, version files.

---

### Task 1: Node-safe core helpers and the guard test

**Files:**
- Create: `src/core/portable-path.ts`, `tests/core/portable-path.test.ts`, `tests/core/mod-safe.test.ts`
- Modify: `src/core/tool-names.ts:26-28`, `src/server/enforcement-mode.ts:42`
- Test: `tests/core/tool-names.test.ts` (add one case)

**Interfaces:**
- Produces: `isAbsolute(p)`, `resolve(base, ...paths)`, `relative(from, to)`, `dirname(p)`, `join(...parts)`, `normalize(p)`, `toSlash(p)` — all `string` in/out, `/`-separated output, drive letter kept. `setPluginInstall(value: boolean | undefined): void`. `MOD_ENTRIES: string[]` in the guard test.

- [ ] **Step 1: Write the failing tests**

`tests/core/portable-path.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  toSlash,
} from "../../src/core/portable-path.ts";

describe("portable-path", () => {
  it("treats POSIX and Windows roots as absolute", () => {
    expect(isAbsolute("/repo/a.ts")).toBe(true);
    expect(isAbsolute("C:\\repo\\a.ts")).toBe(true);
    expect(isAbsolute("c:/repo")).toBe(true);
    expect(isAbsolute("src/a.ts")).toBe(false);
    expect(isAbsolute("C:relative")).toBe(false);
  });

  it("resolves like node:path on POSIX", () => {
    expect(resolve("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolve("/repo/wt", "../x/./y.ts")).toBe("/repo/x/y.ts");
    expect(resolve("/repo", "/abs/b.ts")).toBe("/abs/b.ts");
    expect(resolve("/repo", "")).toBe("/repo");
  });

  it("resolves Windows paths to forward slashes", () => {
    expect(resolve("C:\\repo\\wt", "src\\a.ts")).toBe("C:/repo/wt/src/a.ts");
  });

  it("computes relative paths", () => {
    expect(relative("/repo", "/repo/packages/api")).toBe("packages/api");
    expect(relative("/repo", "/repo")).toBe("");
    expect(relative("/repo/a", "/repo/b/c")).toBe("../b/c");
    expect(relative("C:\\repo", "C:\\repo\\pkg")).toBe("pkg");
  });

  it("dirname, join, toSlash", () => {
    expect(dirname("/repo/src/a.ts")).toBe("/repo/src");
    expect(dirname("/a")).toBe("/");
    expect(join("/repo", "agents", "tp-run.md")).toBe("/repo/agents/tp-run.md");
    expect(toSlash("C:\\a\\b")).toBe("C:/a/b");
  });
});
```

Add to `tests/core/tool-names.test.ts`:

```ts
import { setPluginInstall, toolPrefix } from "../../src/core/tool-names.ts";

it("takes the install kind from setPluginInstall, without process.env", () => {
  setPluginInstall(true);
  expect(toolPrefix()).toBe("mcp__plugin_token-pilot_token-pilot__");
  setPluginInstall(false);
  expect(toolPrefix()).toBe("mcp__token-pilot__");
  setPluginInstall(undefined);
});
```

`tests/core/mod-safe.test.ts`:

```ts
/**
 * A Claude Code mod runs without Node: no node:* modules, no npm packages,
 * no `process`. One such dependency anywhere on the mod's import graph makes
 * the mod fail to load, or makes a hook throw `process is not defined`. That
 * really happened in the 2026-10-04 spike, from core/tool-names.ts.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MOD_ENTRIES = [
  "src/core/portable-path.ts",
  "src/core/tool-names.ts",
  "src/core/token-estimator.ts",
  "src/server/enforcement-mode.ts",
  "src/hooks/pre-bash.ts",
  "src/hooks/pre-grep.ts",
  "src/hooks/post-bash.ts",
  "src/hooks/pre-edit.ts",
  "src/hooks/user-prompt.ts",
  "src/hooks/adaptive-threshold.ts",
];

const IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
const PROCESS =
  /(?<![\w.?])process\.(?:env|cwd|stderr|stdout|exit|argv|platform|pid|version)\b/;

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

function nodeDependencies(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const stack = [resolve(entry)];

  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const code = stripComments(readFileSync(file, "utf-8"));
    if (PROCESS.test(code)) found.push(`${file}: reads process`);

    for (const [, spec] of code.matchAll(IMPORT)) {
      if (!spec.startsWith(".")) {
        found.push(`${file}: imports ${spec}`);
        continue;
      }
      const target = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
      if (existsSync(target)) stack.push(target);
    }
  }

  return found;
}

describe("modules the mod imports need no Node", () => {
  for (const entry of MOD_ENTRIES) {
    it(entry, () => expect(nodeDependencies(entry)).toEqual([]));
  }
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/core/portable-path.test.ts tests/core/tool-names.test.ts tests/core/mod-safe.test.ts`
Expected: FAIL. `portable-path.ts` does not exist, `setPluginInstall` is not exported, and the guard reports `src/core/tool-names.ts: reads process` and `src/server/enforcement-mode.ts: reads process`.

- [ ] **Step 3: Implement**

`src/core/portable-path.ts`:

```ts
/**
 * Path helpers for code that also runs inside a Claude Code mod, which has
 * no node:path. Accepts `/` and `\`, returns `/`-separated paths and keeps a
 * Windows drive prefix — Node and Claude Code accept forward slashes on
 * Windows. Comparisons are case-sensitive, like node:path on POSIX.
 */

const DRIVE = /^[A-Za-z]:/;

export function toSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isAbsolute(p: string): boolean {
  const s = toSlash(p);
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

function split(p: string): { root: string; parts: string[] } {
  const s = toSlash(p);
  const drive = DRIVE.exec(s)?.[0] ?? "";
  const rest = s.slice(drive.length);
  const root = drive + (rest.startsWith("/") ? "/" : "");

  return { root, parts: rest.split("/").filter(Boolean) };
}

export function normalize(p: string): string {
  const { root, parts } = split(p);
  const out: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!root) out.push("..");
      continue;
    }
    out.push(part);
  }

  return root + out.join("/") || ".";
}

export function resolve(base: string, ...paths: string[]): string {
  let acc = base;
  for (const p of paths) acc = isAbsolute(p) ? p : `${acc}/${p}`;

  return normalize(acc);
}

export function relative(from: string, to: string): string {
  const a = split(normalize(from));
  const b = split(normalize(to));
  if (a.root.toLowerCase() !== b.root.toLowerCase()) return normalize(to);

  let i = 0;
  while (i < a.parts.length && i < b.parts.length && a.parts[i] === b.parts[i]) i++;

  return [...a.parts.slice(i).map(() => ".."), ...b.parts.slice(i)].join("/");
}

export function dirname(p: string): string {
  const { root, parts } = split(normalize(p));
  return root + parts.slice(0, -1).join("/") || ".";
}

export function join(...parts: string[]): string {
  return normalize(parts.join("/"));
}
```

`src/core/tool-names.ts` — replace `toolPrefix` with:

```ts
let pluginInstall: boolean | undefined;

/**
 * The mod knows it runs as a plugin but has no process.env to tell; it
 * declares it here once. `undefined` returns to env detection (tests).
 */
export function setPluginInstall(value: boolean | undefined): void {
  pluginInstall = value;
}

/** The prefix alone — for messages that list several tools. */
export function toolPrefix(): string {
  const isPlugin =
    pluginInstall ?? Boolean(globalThis.process?.env?.CLAUDE_PLUGIN_ROOT);
  return isPlugin ? PLUGIN_PREFIX : NPM_PREFIX;
}
```

`src/server/enforcement-mode.ts:42` — the default warn must not touch `process` inside a mod:

```ts
  warn: (msg: string) => void = (m) => globalThis.process?.stderr?.write(m + "\n"),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/portable-path.test.ts tests/core/tool-names.test.ts tests/core/mod-safe.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Run the full suite and commit**

Run: `npx vitest run`
Expected: all green, no count lower than before.

```bash
git add src/core/portable-path.ts src/core/tool-names.ts src/server/enforcement-mode.ts tests/core/portable-path.test.ts tests/core/tool-names.test.ts tests/core/mod-safe.test.ts
git commit -m "refactor: node-free path helpers and process-safe tool prefix for the Claude Code mod"
```

---

### Task 2: Split the pure halves out of Node modules

Move-only refactors. Behaviour does not change, every existing test stays green, and each new module joins `MOD_ENTRIES`.

**Files:**
- Create: `src/hooks/find-checkout.ts`, `src/core/agent-index-fs.ts`, `src/hooks/agent-budget.ts`, `src/hooks/session-context.ts`, `src/hooks/read-gate.ts`, `tests/hooks/read-gate.test.ts`
- Modify: `src/hooks/mcp-path.ts:23-24,139-154`, `src/hooks/hook-mcp-path.ts:15-19`, `tests/hooks/mcp-path.test.ts:190-194`, `src/core/agent-matcher.ts:269-290`, `src/hooks/post-task.ts`, `src/hooks/session-start.ts`, `src/index.ts:119,1032-1042,1086-1087,1126-1134`, `tests/core/mod-safe.test.ts`

**Interfaces:**
- Consumes: `resolve`, `relative`, `isAbsolute` from Task 1.
- Produces:
  - `findCheckout(dir: string): string | null` (Node) in `src/hooks/find-checkout.ts`.
  - `buildAgentIndexFromFiles(files: ReadonlyArray<{ fileName: string; body: string }>): AgentIndex` in `agent-matcher.ts`.
  - `buildAgentIndex(dir): Promise<AgentIndex>` in `agent-index-fs.ts`.
  - `parseAgentBudget`, `decideBudgetAdvice` and their types in `agent-budget.ts`.
  - `AgentEntry`, `parseAgentEntry(fileName: string, content: string): AgentEntry`, `buildReminderMessage`, `profileBannerNote`, `buildSubagentAdoptionNudge`, `MANDATORY_BLOCK`, `DECISION_GUIDE` in `session-context.ts`.
  - `CODE_EXTENSIONS`, `isCodeFile(path): boolean`, `effectiveReadSpanLines`, and `decideReadGate(input): ReadGate` in `read-gate.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/hooks/read-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideReadGate, isCodeFile } from "../../src/hooks/read-gate.ts";

const big = "const x = 1;\n".repeat(400);

describe("decideReadGate", () => {
  it("passes non-code files and bounded spans under the threshold", () => {
    expect(isCodeFile("a.md")).toBe(false);
    expect(
      decideReadGate({ filePath: "a.ts", content: big, offset: 1, limit: 50, threshold: 300 }).kind,
    ).toBe("pass");
  });

  it("gates a whole-file read of a big code file", () => {
    const g = decideReadGate({ filePath: "a.ts", content: big, offset: null, limit: null, threshold: 300 });
    expect(g).toMatchObject({ kind: "gate", lineCount: 401, spanLines: 401 });
    if (g.kind === "gate") expect(g.estTokens).toBeGreaterThan(0);
  });
});
```

Add to `tests/hooks/mcp-path.test.ts` (inside `describe("decideMcpPath — session inside another worktree")`):

```ts
it("rewrites Windows-style relative paths", () => {
  const winCheckout = (dir: string): string | null =>
    dir.replace(/\\/g, "/").startsWith("C:/repo/.worktrees/f")
      ? "C:/repo/.worktrees/f"
      : dir.toLowerCase().startsWith("c:")
        ? "C:/repo"
        : null;
  const d = decideMcpPath(
    {
      tool_name: "mcp__token-pilot__smart_read",
      tool_input: { path: "src\\a.ts" },
      cwd: "C:\\repo\\.worktrees\\f",
    },
    { projectRoot: "C:\\repo", checkoutOf: winCheckout },
  );

  expect(d.kind).toBe("rewrite");
  if (d.kind === "rewrite") expect(d.updatedInput.path).toBe("C:/repo/.worktrees/f/src/a.ts");
});
```

Change the `findCheckout` import at `tests/hooks/mcp-path.test.ts:194` to `await import("../../src/hooks/find-checkout.ts")`.

Extend `MOD_ENTRIES` with `src/hooks/mcp-path.ts`, `src/core/agent-matcher.ts`, `src/hooks/pre-task.ts`, `src/hooks/agent-budget.ts`, `src/hooks/session-context.ts` and `src/hooks/read-gate.ts`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/hooks/read-gate.test.ts tests/hooks/mcp-path.test.ts tests/core/mod-safe.test.ts`
Expected: FAIL. `read-gate.ts` and `find-checkout.ts` are missing, and the guard flags `node:fs`/`node:path` in `mcp-path.ts` and `agent-matcher.ts`.

- [ ] **Step 3: Implement the moves**

1. **mcp-path.** Move `findCheckout` (with its doc comment) verbatim into `src/hooks/find-checkout.ts`, together with its imports `existsSync` from `node:fs` and `dirname, join, resolve` from `node:path`. In `mcp-path.ts`, replace both Node imports with:
   ```ts
   import { isAbsolute, relative, resolve } from "../core/portable-path.js";
   ```
   In `hook-mcp-path.ts`, import `findCheckout` from `"./find-checkout.js"` and the rest from `"./mcp-path.js"`.
2. **agent-matcher.** Delete the `node:fs` (and, if present, `node:path`) imports. Replace `buildAgentIndex` with:
   ```ts
   /** Index tp-*.md agent files the caller already read (Node or the mod). */
   export function buildAgentIndexFromFiles(
     files: ReadonlyArray<{ fileName: string; body: string }>,
   ): AgentIndex {
     const agents: ParsedAgent[] = [];
     for (const { fileName, body } of files) {
       if (!fileName.startsWith("tp-") || !fileName.endsWith(".md")) continue;
       const parsed = parseAgent(fileName.slice(0, -".md".length), body);
       if (parsed) agents.push(parsed);
     }

     return { agents };
   }
   ```
   Then create `src/core/agent-index-fs.ts`:
   ```ts
   import { promises as fs } from "node:fs";
   import { join } from "node:path";
   import { buildAgentIndexFromFiles, type AgentIndex } from "./agent-matcher.js";

   /** Read tp-*.md from `agentsDir`. Missing dir or unreadable file → skipped, never thrown. */
   export async function buildAgentIndex(agentsDir: string): Promise<AgentIndex> {
     let entries: string[];
     try {
       entries = await fs.readdir(agentsDir);
     } catch {
       return { agents: [] };
     }

     const files: Array<{ fileName: string; body: string }> = [];
     for (const fileName of entries) {
       if (!fileName.startsWith("tp-") || !fileName.endsWith(".md")) continue;
       try {
         files.push({ fileName, body: await fs.readFile(join(agentsDir, fileName), "utf-8") });
       } catch {
         /* unreadable — skip */
       }
     }

     return buildAgentIndexFromFiles(files);
   }
   ```
   Update every importer of `buildAgentIndex` (`grep -rln "buildAgentIndex" src tests`) to import it from `agent-index-fs.js`.
3. **agent-budget.** Move `parseAgentBudget` and `decideBudgetAdvice`, plus the types and constants they reference, from `post-task.ts` into `src/hooks/agent-budget.ts`. In `post-task.ts`, add `export { parseAgentBudget, decideBudgetAdvice } from "./agent-budget.js";` and the matching `export type { … }` so existing importers keep working.
4. **session-context.** Move into `src/hooks/session-context.ts`: `AgentEntry`, `parseFrontmatter`, `buildSubagentAdoptionNudge`, `buildReminderMessage`, `profileBannerNote`, `MANDATORY_BLOCK`, `DECISION_GUIDE` and the helpers they call. Use `import type` for `HookEvent` and `ToolProfile`. Add:
   ```ts
   /** One tp-*.md file as the session reminder lists it. */
   export function parseAgentEntry(fileName: string, content: string): AgentEntry {
     const fm = parseFrontmatter(content);
     return { name: fm.name ?? fileName.replace(/\.md$/, ""), description: fm.description ?? "" };
   }
   ```
   In `session-start.ts`, have `scanDir` call `parseAgentEntry(filename, content)`, and re-export the moved names.
5. **read-gate.** Move `CODE_EXTENSIONS` (`index.ts:119`) and `effectiveReadSpanLines` (`index.ts:1032`) into `src/hooks/read-gate.ts`, and add:
   ```ts
   export function isCodeFile(filePath: string): boolean {
     return CODE_EXTENSIONS.has(filePath.split(".").pop()?.toLowerCase() ?? "");
   }

   export type ReadGate =
     | { kind: "pass" }
     | { kind: "gate"; lineCount: number; spanLines: number; estTokens: number };

   /** Decide on content the caller already read. Path safety stays with the caller. */
   export function decideReadGate(input: {
     filePath: string;
     content: string;
     offset: number | null;
     limit: number | null;
     threshold: number;
   }): ReadGate {
     if (!isCodeFile(input.filePath)) return { kind: "pass" };

     const lineCount = input.content.split("\n").length;
     const spanLines = effectiveReadSpanLines(lineCount, input.offset, input.limit);
     if (spanLines <= input.threshold) return { kind: "pass" };

     // Cost reflects the span the read would pull (v0.45.0, token-pilot-xg9).
     const spanRatio = lineCount > 0 ? Math.min(1, spanLines / lineCount) : 1;
     const charEst = Math.ceil((input.content.length * spanRatio) / 4);
     const wsRatio = (input.content.match(/\s/g)?.length ?? 0) / input.content.length;

     return { kind: "gate", lineCount, spanLines, estTokens: Math.ceil(charEst * (1 - wsRatio * 0.3)) };
   }
   ```
   In `index.ts`:
   - Re-export `CODE_EXTENSIONS` and `effectiveReadSpanLines` from `./hooks/read-gate.js`.
   - Replace lines 1086-1087 with `if (!isCodeFile(filePath)) return null;`.
   - Replace lines 1126-1134 with:
     ```ts
     const gate = decideReadGate({ filePath, content: fileContent, offset: offsetVal, limit: limitVal, threshold: effectiveThreshold });
     if (gate.kind === "pass") return null;
     const estTokens = gate.estTokens;
     ```
     Keep `lineCount` from the existing read for the telemetry below.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green, including the 15 existing `mcp-path` tests, the new Windows case and the guard.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "refactor: split node-free decision code out of hook modules for the mod"
```

---

### Task 3: Pure config resolution

**Files:**
- Create: `src/config/resolve.ts`, `tests/config/resolve.test.ts`
- Modify: `src/config/loader.ts`, `tests/core/mod-safe.test.ts`

**Interfaces:**
- Produces: `resolveConfig(userConfig: Record<string, unknown> | null, env: Readonly<Record<string, string | undefined>>, warn?: (m: string) => void): TokenPilotConfig`.

Note: today `loadConfig` returns plain defaults when `.token-pilot.json` is missing, and the `TOKEN_PILOT_*` env overrides are **not** applied in that case. Keep that: the loader passes `{}` as `env` when the file is missing, and the mod does the same. Whether that is intended is a separate question; this plan does not change it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveConfig } from "../../src/config/resolve.ts";
import { DEFAULT_CONFIG } from "../../src/config/defaults.ts";

describe("resolveConfig", () => {
  it("applies env overrides from the env it is given", () => {
    expect(resolveConfig({}, { TOKEN_PILOT_DENY_THRESHOLD: "120" }).hooks.denyThreshold).toBe(120);
  });

  it("falls back to the default mode on an unknown one and warns", () => {
    const warnings: string[] = [];
    const c = resolveConfig({ hooks: { mode: "nope" } }, {}, (m) => warnings.push(m));

    expect(c.hooks.mode).toBe(DEFAULT_CONFIG.hooks.mode);
    expect(warnings[0]).toContain('Unknown hooks.mode "nope"');
  });

  it("returns a copy, never the shared defaults object", () => {
    const c = resolveConfig(null, {});
    c.hooks.denyThreshold = 1;
    expect(DEFAULT_CONFIG.hooks.denyThreshold).not.toBe(1);
  });
});
```

Add `src/config/resolve.ts` to `MOD_ENTRIES`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/config/resolve.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Move `VALID_HOOK_MODES`, `cloneDefaults`, `deepMerge`, `applyHookModeMigration` and `applyEnvOverrides` from `loader.ts` into `src/config/resolve.ts`. Change them as follows:
- `applyHookModeMigration(merged, userConfig, warn)` calls `warn(...)` where it called `console.error(...)`.
- `applyEnvOverrides(merged, env)` reads `env.TOKEN_PILOT_DENY_THRESHOLD`, `env.TOKEN_PILOT_ADAPTIVE_THRESHOLD` and `env.TOKEN_PILOT_ADAPTIVE_BUDGET` where it read `process.env`.

Then:

```ts
export function resolveConfig(
  userConfig: Record<string, unknown> | null,
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void = () => {},
): TokenPilotConfig {
  const merged = deepMerge(cloneDefaults(), userConfig ?? {}) as TokenPilotConfig;
  applyHookModeMigration(merged, userConfig ?? {}, warn);
  applyEnvOverrides(merged, env);

  return merged;
}
```

In `loader.ts`:
- The missing-file branch returns `resolveConfig(null, {})`.
- The success path keeps `applyLegacyDenyMigration` (it writes the file; Node only) and then returns `resolveConfig(userConfig, process.env, (m) => console.error(m))`.

- [ ] **Step 4: Run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green; the existing loader tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/config tests/config tests/core/mod-safe.test.ts
git commit -m "refactor: pure config resolution shared by the CLI and the mod"
```

---

### Task 4: The mod skeleton, the hand-off flag, telemetry and the test runner

**Files:**
- Create: `hooks/mod/register.ts`, `hooks/mod/host.ts`, `hooks/mod/register.test.ts`, `scripts/test-mod.mjs`, `tests/hooks/run-sh.test.ts`, `src/core/hook-event.ts`
- Modify: `hooks/hooks.json`, `hooks/run.sh`, `package.json` (scripts), `.github/workflows/ci.yml`, `src/core/event-log.ts` (export `rotateIfNeeded`; build records via `hook-event.ts`), `src/index.ts:921` (rotate at server start), `tests/core/mod-safe.test.ts`

**Interfaces:**
- Produces:
  - `SERVED: string[]` in `register.ts`. Every later task appends its actions.
  - `host.ts`:
    - `appendLine($, file, line): void`
    - `tpDir($): Promise<string>`
    - `modConfig($): Promise<TokenPilotConfig>`
    - `checkoutOf($, dir): Promise<string | null>`
    - `readAgentFiles($, dir): Promise<Array<{ fileName; body }>>`
    - `withContext(ran, notes: string[])`
    - `PREFIX = 'mcp__plugin_token-pilot_token-pilot__'`
  - `hook-event.ts`: `diagnosticEvent(args, now): HookEvent` and `tagEvent(event, env): HookEvent`, moved from `appendDiagnostic`/`appendEvent`.

- [ ] **Step 1: Write the failing tests**

`tests/hooks/run-sh.test.ts` (CI runs `npm run build` before `npm test`, so `dist/` exists):

```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const CAT = JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat src/index.ts" } });
const run = (action: string, flag: string) =>
  spawnSync("sh", ["hooks/run.sh", action], {
    input: CAT,
    encoding: "utf8",
    env: { ...process.env, TOKEN_PILOT_MOD: flag },
  });

describe("hooks/run.sh hand-off to the mod", () => {
  it("exits silently when the mod serves the action", () => {
    const r = run("hook-pre-bash", "hook-read,hook-pre-bash");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("still runs the hook for a near-miss or an empty flag", () => {
    for (const flag of ["hook-pre", "hook-pre-bash-x", ""]) {
      expect(run("hook-pre-bash", flag).stdout).toContain('"permissionDecision":"deny"');
    }
  });
});
```

`hooks/mod/register.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'

test('hands the served command hooks off before they run', async ($, on) => {
  const set: Array<{ name: string; value?: string }> = []
  on('env.set', async (_$, e) => {
    set.push(e as any)
    return { value: undefined } as any
  })
  on('classic.SessionStart', async () => ({}) as any)

  await ($ as any).classic.SessionStart({ source: 'startup' })

  expect(set.some(s => s.name === 'TOKEN_PILOT_MOD')).toBe(true)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run build && npx vitest run tests/hooks/run-sh.test.ts`
Expected: FAIL on the first case (run.sh ignores the flag today and prints a deny).

- [ ] **Step 3: Implement**

`hooks/run.sh`, after the header comment and before `PLUGIN_DIR=`:

```sh
# A Claude Code mod (hooks/mod) that serves this action has already handled
# the call in-process; it lists the actions it serves in TOKEN_PILOT_MOD at
# session start. Exact, comma-delimited match: hook-pre must not silence
# hook-pre-bash.
case ",${TOKEN_PILOT_MOD:-}," in
	*",$1,"*) exit 0 ;;
esac
```

After the existing `[ -f "$ENTRY" ] || exit 0` line:

```sh
# The MCP-path hook has its own small entry (about 23 ms instead of 200).
[ "$1" = hook-mcp-path ] && exec node "$PLUGIN_DIR/dist/hooks/hook-mcp-path.js"
```

`hooks/hooks.json`:
- Add `"modules": ["./mod/register.ts"],` as the first top-level key.
- Change the `mcp__(plugin_token-pilot_)?token-pilot__.*` command to `sh \"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh\" hook-mcp-path`.

`src/core/hook-event.ts`: move the record-building half of `appendDiagnostic` into `diagnosticEvent(args, now)`, and the workflow/task tagging half of `appendEvent` into `tagEvent(event, env)`. `env` is a plain record; `event-log.ts` passes `process.env`. The file has no Node imports (`import type { HookEvent }` only). `appendEvent` and `appendDiagnostic` call these two functions. Export `rotateIfNeeded` from `event-log.ts`, and call `rotateIfNeeded(projectRoot).catch(() => {})` next to `applyRetention` at `src/index.ts:921`. Once the mod writes the log, appends stop rotating it; the server does it at start.

`hooks/mod/host.ts`:

```ts
import type { EngineInterface } from 'claude-code'
import { resolveConfig } from '../../src/config/resolve.js'
import { dirname, join } from '../../src/core/portable-path.js'
import type { TokenPilotConfig } from '../../src/types.js'

type $T = EngineInterface

export const PREFIX = 'mcp__plugin_token-pilot_token-pilot__'

/**
 * Append one line. `$.fs` only replaces whole files, so a tiny `sh` appends.
 * Not awaited by callers: telemetry must never slow a tool call, and a
 * failure is dropped.
 */
export function appendLine($: $T, file: string, line: string): void {
  void $.process
    .run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', file], { stdin: line + '\n' })
    .catch(() => {})
}

export async function tpDir($: $T): Promise<string> {
  return join(await $.session.root(), '.token-pilot')
}

/** Same rules as loadConfig: no file → plain defaults, env overrides ignored. */
export async function modConfig($: $T): Promise<TokenPilotConfig> {
  const file = join(await $.session.root(), '.token-pilot.json')
  let user: Record<string, unknown> | null = null
  try {
    user = JSON.parse(String(await $.fs.read(file)))
  } catch {
    return resolveConfig(null, {})
  }

  return resolveConfig(user, {
    TOKEN_PILOT_DENY_THRESHOLD: await $.env.get('TOKEN_PILOT_DENY_THRESHOLD'),
    TOKEN_PILOT_ADAPTIVE_THRESHOLD: await $.env.get('TOKEN_PILOT_ADAPTIVE_THRESHOLD'),
    TOKEN_PILOT_ADAPTIVE_BUDGET: await $.env.get('TOKEN_PILOT_ADAPTIVE_BUDGET'),
  })
}

const checkouts = new Map<string, string | null>()

/** Nearest ancestor holding `.git` (dir = main checkout, file = linked worktree). */
export async function checkoutOf($: $T, dir: string): Promise<string | null> {
  if (checkouts.has(dir)) return checkouts.get(dir) ?? null

  let found: string | null = null
  for (let cur = dir; ; cur = dirname(cur)) {
    if (await $.fs.exists(join(cur, '.git'))) {
      found = cur
      break
    }
    if (dirname(cur) === cur) break
  }
  checkouts.set(dir, found)

  return found
}

export async function readAgentFiles($: $T, dir: string): Promise<Array<{ fileName: string; body: string }>> {
  const files: Array<{ fileName: string; body: string }> = []
  try {
    for (const entry of await $.fs.list(dir)) {
      const fileName = String((entry as { name: string }).name)
      if (!fileName.startsWith('tp-') || !fileName.endsWith('.md')) continue
      files.push({ fileName, body: String(await $.fs.read(join(dir, fileName))) })
    }
  } catch {
    /* no agents dir — empty */
  }

  return files
}

/** Add model-facing notes after a tool result; never on a deny or an error. */
export function withContext<R extends { deny?: unknown; isError?: unknown; context?: readonly string[] }>(
  ran: R,
  notes: string[],
): R {
  if (!notes.length || ran.deny !== undefined || ran.isError) return ran
  return { ...ran, context: [...(ran.context ?? []), ...notes] }
}
```

`hooks/mod/register.ts`:

```ts
import type { EngineInterface, Register } from 'claude-code'
import { setPluginInstall } from '../../src/core/tool-names.js'

/**
 * Command-hook actions this mod handles in-process. hooks/run.sh exits early
 * for each one, so no call is handled twice. With the mod off, nothing is
 * set and every command hook runs as before.
 */
const SERVED: string[] = []

export const register: Register = on => {
  setPluginInstall(true)

  const handOff = ($: EngineInterface) => $.env.set('TOKEN_PILOT_MOD', SERVED.join(','))

  // Mod hooks run before the command hooks, so the flag set here is already
  // visible to the command SessionStart of this same session.
  on('classic.SessionStart', async ($, e, next) => {
    await handOff($)
    return next(e)
  })

  // Again on a hot reload, where classic.SessionStart does not fire.
  on('session.start', async ($, e, next) => {
    await handOff($)
    return next(e)
  })
}
```

`scripts/test-mod.mjs`:

```js
// `claude plugin test` runs every *.test.ts under the folder it is given, so
// the repo's vitest suite would be swept in and fail to load. It also exits 0
// when it finds no hooks module. Stage the plugin without tests/ and require
// a real pass count.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const stage = mkdtempSync(join(tmpdir(), "tp-mod-"));
try {
  for (const dir of [".claude-plugin", "hooks", "src"]) {
    cpSync(dir, join(stage, dir), { recursive: true });
  }

  for (const args of [["plugin", "validate", stage], ["plugin", "test", stage]]) {
    const run = spawnSync("claude", args, { encoding: "utf8" });
    const out = `${run.stdout}${run.stderr}`;
    process.stdout.write(out);
    if (run.status !== 0) process.exit(1);
    if (args[1] === "test" && Number(/(\d+) pass/.exec(out)?.[1] ?? 0) === 0) process.exit(1);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
```

`package.json` → `"test:mod": "node scripts/test-mod.mjs"`.

`.github/workflows/ci.yml`: after `npm test`, add:

```yaml
      - name: Mod tests (Claude Code plugin engine)
        run: |
          npm i -g @anthropic-ai/claude-code@2.1.289
          npm run test:mod
```

(Verified locally: `claude plugin test` needs no credentials — 3/3 passed with an empty `CLAUDE_CONFIG_DIR`.)

- [ ] **Step 4: Run**

Run: `npm run build && npx vitest run tests/hooks/run-sh.test.ts && npm run test:mod && npx vitest run`
Expected: PASS. `test:mod` prints `Validation passed` and `1 pass`.

- [ ] **Step 5: Live check on Claude Code 2.1.289 and 2.1.250**

In the WSL/Ubuntu terminal, from the repo root:

```bash
echo '{"enabledPlugins":{"token-pilot@token-pilot":false}}' > /tmp/tp-off.json
claude -p --plugin-dir . --settings /tmp/tp-off.json --allowedTools "Bash" --max-turns 4 \
  "Run with the Bash tool: cat src/index.ts. Quote the first sentence of any refusal." < /dev/null
```

Expected: the refusal "`cat` on a code file dumps the whole thing into context." The mod serves nothing yet, so the command hook answered.

For 2.1.250, install it once into a scratch dir (`npm i @anthropic-ai/claude-code@2.1.250`) and run the same command with that binary and `DISABLE_AUTOUPDATER=1`. Expected: the same refusal, and no mod error.

- [ ] **Step 6: Commit**

```bash
git add hooks scripts/test-mod.mjs package.json .github/workflows/ci.yml src tests
git commit -m "feat: Claude Code mod skeleton with a hand-off flag the command hooks honour"
```

---

### Task 5: Bash — pre-check and post-advice in one hook

**Files:**
- Create: `hooks/mod/bash.ts`, `hooks/mod/bash.test.ts`
- Modify: `hooks/mod/register.ts`

**Interfaces:**
- Consumes: `decidePreBash`, `decidePostBashAdvice` (`src/hooks/*`), `parseEnforcementMode`, `diagnosticEvent`, `tagEvent`, host helpers.
- Produces: `registerBash(on: On): void`, `BASH_ACTIONS = ['hook-pre-bash', 'hook-post-bash']`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'claude-code/testing'

const stubs = (on: any) => {
  on('env.get', async () => ({ value: undefined }))
  on('env.set', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

test('denies cat on a code file before Bash runs', async ($, on) => {
  stubs(on)
  let ran = false
  on('tool.call', { tool: 'Bash' }, () => {
    ran = true
    return { result: { stdout: '', stderr: '' } } as any
  })

  const res: any = await $.tool.call({ tool: 'Bash', command: 'cat src/index.ts' } as any)

  expect(res.deny).toContain('`cat` on a code file')
  expect(ran).toBe(false)
})

test('adds advice after a very large output', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'x\n'.repeat(9000), stderr: '' }, text: 'x\n'.repeat(9000) }) as any)

  const res: any = await $.tool.call({ tool: 'Bash', command: 'make' } as any)

  expect(res.deny).toBe(undefined)
  expect((res.context ?? []).join('\n')).toMatch(/output/i)
})
```

- [ ] **Step 2: Run** `npm run test:mod`. Expected: FAIL (no Bash hook yet).

- [ ] **Step 3: Implement** `hooks/mod/bash.ts`:

```ts
import type { On } from 'claude-code'
import { decidePreBash } from '../../src/hooks/pre-bash.js'
import { decidePostBashAdvice } from '../../src/hooks/post-bash.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import { diagnosticEvent, tagEvent } from '../../src/core/hook-event.js'
import { appendLine, tpDir, withContext } from './host.js'

export const BASH_ACTIONS = ['hook-pre-bash', 'hook-post-bash']

export function registerBash(on: On): void {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const mode = parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE'))
    const decision = decidePreBash({ tool_name: 'Bash', tool_input: { command } }, mode)

    if (decision.kind === 'deny') {
      const event = diagnosticEvent({ code: 'bash_denied', detail: { command: command.slice(0, 200) } }, Date.now())
      appendLine($, `${await tpDir($)}/hook-events.jsonl`, JSON.stringify(tagEvent(event, {})))
      return { deny: decision.reason }
    }

    const ran = await next(e)
    const advice = decidePostBashAdvice({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: ran.text ?? '' } })

    return withContext(ran, [
      ...(decision.kind === 'advise' ? [decision.reason] : []),
      ...(advice.additionalContext ? [advice.additionalContext] : []),
    ])
  })
}
```

Use the file `currentLogPath` returns (`src/core/event-log.ts:133`). If that is not `.token-pilot/hook-events.jsonl`, build the same path. In `register.ts`, call `registerBash(on)` inside `register` and spread `...BASH_ACTIONS` into `SERVED`.

- [ ] **Step 4: Run** `npm run test:mod && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Live check** — rerun Task 4's `claude -p` command. Expected: same refusal. `grep bash_denied .token-pilot/hook-events.jsonl | tail -1` shows a fresh line, which proves the un-awaited append landed. Then `TOKEN_PILOT_MOD` must contain `hook-pre-bash`: add `echo "$TOKEN_PILOT_MOD" > /tmp/tp-flag` as a temporary first line of `run.sh`, run once, read the file, and remove the line.

- [ ] **Step 6: Commit** — `git commit -am "feat(mod): Bash pre-check and post-advice in-process"` (plus `git add hooks/mod/bash*.ts`).

---

### Task 6: Grep

**Files:** Create `hooks/mod/grep.ts`, `hooks/mod/grep.test.ts`; modify `hooks/mod/register.ts`.

**Interfaces:** Produces `registerGrep(on)`, `GREP_ACTIONS = ['hook-pre-grep']`.

- [ ] **Step 1: Failing test** (same `stubs` as Task 5; copy it into the file):

```ts
test('points a symbol-like Grep at find_usages', async ($, on) => {
  stubs(on)
  on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'content', numFiles: 0, filenames: [] } }) as any)

  const res: any = await $.tool.call({ tool: 'Grep', pattern: 'decidePreBash' } as any)

  expect(res.deny).toContain('find_usages')
})
```

- [ ] **Step 2: Run** `npm run test:mod` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { On } from 'claude-code'
import { decidePreGrep } from '../../src/hooks/pre-grep.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import { withContext } from './host.js'

export const GREP_ACTIONS = ['hook-pre-grep']

export function registerGrep(on: On): void {
  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    const mode = parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE'))
    const decision = decidePreGrep({ tool_name: 'Grep', tool_input: { ...e } } as never, mode)
    if (decision.kind === 'deny') return { deny: decision.reason }

    return withContext(await next(e), decision.kind === 'advise' ? [decision.reason] : [])
  })
}
```

Register it and add `GREP_ACTIONS` to `SERVED`.

- [ ] **Step 4: Run** `npm run test:mod && npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(mod): Grep gate in-process`.

---

### Task 7: MCP paths, and watching read_for_edit

The one unmatched `tool.call` in the mod. It serves two jobs: worktree path rewrites for our MCP tools, and recording `read_for_edit` calls for Task 8.

**Files:** Create `hooks/mod/mcp.ts`, `hooks/mod/mcp.test.ts`; modify `hooks/mod/register.ts`.

**Interfaces:**
- Consumes: `decideMcpPath`, `checkoutOf`, `PREFIX`, `withContext`, `isAbsolute`/`resolve`/`normalize`.
- Produces:
  - `createEditPrep(): EditPrep`, where `EditPrep = { mark(path: string): void; isFresh(path: string, now: number): boolean }`, keyed by normalized absolute path, 30-minute TTL (same as `src/core/edit-prep-state.ts:31`).
  - `handleMcp($, e, next, prep)`, called from the unmatched hook in `register.ts`.
  - `MCP_ACTIONS = ['hook-mcp-path']`.

- [ ] **Step 1: Failing tests**

```ts
import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'

test('resolves a relative path against the worktree the session moved into', async ($, on) => {
  on('session.root', async () => ({ value: '/repo' }) as any)
  on('session.cwd', async () => ({ value: '/repo/.worktrees/f/src' }) as any)
  on('fs.exists', async (_$, e: any) => ({ value: e.path === '/repo/.git' || e.path === '/repo/.worktrees/f/.git' }) as any)
  let seen: any
  on('tool.call', async (_$, e) => {
    seen = e
    return { result: 'ok', text: 'ok' } as any
  })

  await $.tool.call({ tool: `${P}smart_read`, path: 'src/a.ts' } as any)

  expect(seen.path).toBe('/repo/.worktrees/f/src/a.ts')
})

test('leaves calls in the server checkout untouched', async ($, on) => {
  on('session.root', async () => ({ value: '/repo' }) as any)
  on('session.cwd', async () => ({ value: '/repo/src' }) as any)
  on('fs.exists', async (_$, e: any) => ({ value: e.path === '/repo/.git' }) as any)
  let seen: any
  on('tool.call', async (_$, e) => {
    seen = e
    return { result: 'ok', text: 'ok' } as any
  })

  await $.tool.call({ tool: `${P}smart_read`, path: 'src/a.ts' } as any)

  expect(seen.path).toBe('src/a.ts')
})
```

If the test engine names the `fs.exists` argument differently from `e.path`, log `e` once and adjust the stub; the event's argument shape is in `claude-code.d.ts` under `'fs.exists'`.

- [ ] **Step 2: Run** `npm run test:mod` → FAIL.

- [ ] **Step 3: Implement** `hooks/mod/mcp.ts`:

```ts
import { decideMcpPath } from '../../src/hooks/mcp-path.js'
import { isAbsolute, normalize, resolve } from '../../src/core/portable-path.js'
import { PREFIX, checkoutOf, withContext } from './host.js'

export const MCP_ACTIONS = ['hook-mcp-path']
const TTL_MS = 30 * 60 * 1000 // same as src/core/edit-prep-state.ts

export type EditPrep = { mark(path: string): void; isFresh(path: string, now: number): boolean }

/** read_for_edit calls seen this session. A reload clears it; the Edit gate then asks again. */
export function createEditPrep(): EditPrep {
  const seen = new Map<string, number>()
  return {
    mark: path => seen.set(normalize(path), Date.now()),
    isFresh: (path, now) => now - (seen.get(normalize(path)) ?? -Infinity) < TTL_MS,
  }
}

export async function handleMcp($: any, e: any, next: (e: any) => Promise<any>, prep: EditPrep) {
  const root: string = await $.session.root()
  const cwd: string = await $.session.cwd()
  const [serverCheckout, sessionCheckout] = [await checkoutOf($, root), await checkoutOf($, cwd)]
  const decision = decideMcpPath(
    { tool_name: e.tool, tool_input: e, cwd },
    { projectRoot: root, checkoutOf: dir => (dir === root ? serverCheckout : dir === cwd ? sessionCheckout : null) },
  )

  const call = decision.kind === 'rewrite' ? { ...e, ...decision.updatedInput } : e
  const ran = await next(call)

  if (e.tool === `${PREFIX}read_for_edit` && ran.deny === undefined && !ran.isError && typeof call.path === 'string') {
    prep.mark(isAbsolute(call.path) ? call.path : resolve(root, call.path))
  }

  const note = decision.kind === 'warn' ? decision.message : decision.kind === 'rewrite' ? decision.note : undefined
  return withContext(ran, note ? [note] : [])
}
```

In `register.ts`:

```ts
const prep = createEditPrep()

on('tool.call', ($, e, next) =>
  e.tool.startsWith(PREFIX) ? handleMcp($, e, next, prep) : next(e),
)
```

Add `MCP_ACTIONS` to `SERVED`. Pass `prep` to Task 8.

- [ ] **Step 4: Run** `npm run test:mod && npx vitest run` → PASS.

- [ ] **Step 5: Live check, including subagents** (WSL terminal, repo root):

```bash
git worktree add -q .worktrees/mod-check -b mod-check
claude -p --plugin-dir . --settings /tmp/tp-off.json --allowedTools "Bash" "mcp__plugin_token-pilot_token-pilot__smart_read" "ToolSearch" "Agent" --max-turns 10 \
  "1) Bash: cd .worktrees/mod-check  2) call smart_read with path \"package.json\" and quote its FILE: line  3) use the Agent tool (general-purpose) with prompt 'Bash: cd .worktrees/mod-check, then call smart_read with path package.json and quote the FILE: line'. Report both FILE: lines." < /dev/null
git worktree remove .worktrees/mod-check && git branch -D mod-check
```

Expected: step 2's FILE: line names `.worktrees/mod-check/package.json`.

Read step 3's line and pick one branch:
- **It also names the worktree:** done.
- **It names the main checkout:** `$.session.cwd()` does not follow a subagent's `cd`. In `handleMcp`, rewrite only when `e.agentId === undefined`. Keep `hook-mcp-path` **out of** `SERVED`, so the command hook (which reads each call's own `cwd`) keeps serving subagents. The mod then still records `read_for_edit`. Record the outcome in the CHANGELOG entry (Task 14).

- [ ] **Step 6: Commit** `feat(mod): worktree paths for MCP calls without forcing permission`.

---

### Task 8: Edit gate from observed read_for_edit calls

**Files:** Create `hooks/mod/edit.ts`, `hooks/mod/edit.test.ts`; modify `hooks/mod/register.ts`.

**Interfaces:** Consumes `decidePreEdit`, `isCodeFile`, `EditPrep` (Task 7). Produces `registerEdit(on, prep)`, `EDIT_ACTIONS = ['hook-edit']`.

- [ ] **Step 1: Failing tests**

```ts
import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'
const base = (on: any) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async () => ({ value: true }))
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }))
}

test('denies an Edit of a code file not prepared with read_for_edit', async ($, on) => {
  base(on)

  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toContain('read_for_edit')
})

test('allows the Edit once read_for_edit ran for that file', async ($, on) => {
  base(on)

  await $.tool.call({ tool: `${P}read_for_edit`, path: 'src/a.ts', symbol: 'f' } as any)
  const res: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)

  expect(res.deny).toBe(undefined)
})
```

- [ ] **Step 2: Run** `npm run test:mod` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { On } from 'claude-code'
import { decidePreEdit } from '../../src/hooks/pre-edit.js'
import { isCodeFile } from '../../src/hooks/read-gate.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import type { EditPrep } from './mcp.js'
import { withContext } from './host.js'

export const EDIT_ACTIONS = ['hook-edit']

export function registerEdit(on: On, prep: EditPrep): void {
  for (const tool of ['Edit', 'MultiEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const filePath = String((e as { file_path?: unknown }).file_path ?? '')
      const decision = decidePreEdit(
        { tool_name: tool, tool_input: { file_path: filePath } },
        {
          mode: parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE')),
          isCodeFile: isCodeFile(filePath),
          fileExists: await $.fs.exists(filePath),
          isPrepared: prep.isFresh(filePath, Date.now()),
          bypassed: (await $.env.get('TOKEN_PILOT_BYPASS')) === '1',
        },
      )
      if (decision.kind === 'deny') return { deny: decision.reason }

      return withContext(await next(e), decision.kind === 'advise' ? [decision.message] : [])
    })
  }
}
```

If `claude plugin validate` rejects `MultiEdit` as an unknown tool name on this build, drop it from the loop. Today's Claude Code has no MultiEdit tool.

- [ ] **Step 4: Run** `npm run test:mod && npx vitest run` → PASS.
- [ ] **Step 5: Commit** `feat(mod): Edit gate from read_for_edit calls the mod observes`.

---

### Task 9: Read — answer with the outline instead of refusing

**Files:** Create `hooks/mod/read.ts`, `hooks/mod/read.test.ts`; modify `src/hooks/read-gate.ts` (add `outlineHeader`), `tests/hooks/read-gate.test.ts`, `hooks/mod/register.ts`.

**Interfaces:**
- Consumes: `decideReadGate`, `isCodeFile`, `computeEffectiveThreshold`, `estimateTokens` (`src/core/token-estimator.ts`), `modConfig`, `PREFIX`, `relative`/`isAbsolute`.
- Produces: `outlineHeader(relPath: string, lineCount: number, estTokens: number, prefix: string): string`, `registerRead(on)`, `READ_ACTIONS = ['hook-read']`.

- [ ] **Step 1: Failing tests**

In `tests/hooks/read-gate.test.ts`:

```ts
import { outlineHeader } from "../../src/hooks/read-gate.ts";

it("says plainly that the result is an outline and how to get exact text", () => {
  const h = outlineHeader("src/a.ts", 900, 7000, "mcp__plugin_token-pilot_token-pilot__");
  expect(h).toContain("src/a.ts has 900 lines");
  expect(h).toContain("not the file text");
  expect(h).toContain("offset/limit");
  expect(h).toContain("read_for_edit");
});
```

`hooks/mod/read.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'

const P = 'mcp__plugin_token-pilot_token-pilot__'
const BIG = 'const x = 1;\n'.repeat(800)
const base = (on: any, content = BIG) => {
  on('env.get', async () => ({ value: undefined }))
  on('session.root', async () => ({ value: '/repo' }))
  on('fs.read', async () => ({ value: content }))
  on('fs.stat', async (_$, e: any) => ({ value: { realPath: e.path, size: content.length } }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

test('a whole-file Read of a big code file comes back as the outline', async ($, on) => {
  base(on)
  on('tool.call', async (_$, e: any) =>
    e.tool === `${P}smart_read`
      ? ({ result: 'OUTLINE', text: 'FILE: src/a.ts\nfunction f() [L1-2]' } as any)
      : ({ result: { type: 'text', file: { filePath: e.file_path, content: 'const x = 1;', numLines: 1, startLine: 1, totalLines: 801 } } } as any),
  )

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.result.file.content).toContain('structural outline')
  expect(res.result.file.content).toContain('function f()')
})

test('a bounded Read under the threshold passes untouched', async ($, on) => {
  base(on)
  on('tool.call', async (_$, e: any) => ({ result: { type: 'text', file: { filePath: e.file_path, content: 'RAW', numLines: 1, startLine: 1, totalLines: 801 } } }) as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', offset: 10, limit: 20 } as any)

  expect(res.result.file.content).toBe('RAW')
})

test('a file outside the project passes untouched', async ($, on) => {
  base(on)
  on('tool.call', async (_$, e: any) => ({ result: { type: 'text', file: { filePath: e.file_path, content: 'RAW', numLines: 1, startLine: 1, totalLines: 801 } } }) as any)

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/elsewhere/a.ts' } as any)

  expect(res.result.file.content).toBe('RAW')
})

test('when smart_read fails, the model gets a pointer, not silence', async ($, on) => {
  base(on)
  on('tool.call', async (_$, e: any) => (e.tool === `${P}smart_read` ? ({ deny: 'no server' } as any) : ({ result: {} } as any)))

  const res: any = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)

  expect(res.deny).toContain('smart_read')
})
```

- [ ] **Step 2: Run** both suites → FAIL.

- [ ] **Step 3: Implement**

`src/hooks/read-gate.ts`:

```ts
export function outlineHeader(relPath: string, lineCount: number, estTokens: number, prefix: string): string {
  return (
    `[token-pilot] ${relPath} has ${lineCount} lines (~${estTokens} tokens). ` +
    `Below is its structural outline, not the file text.\n` +
    `Exact lines: Read with offset/limit · one symbol: ${prefix}read_symbol · ` +
    `before an Edit: ${prefix}read_for_edit.\n\n`
  )
}
```

`hooks/mod/read.ts`:

```ts
import type { On } from 'claude-code'
import { decideReadGate, isCodeFile, outlineHeader } from '../../src/hooks/read-gate.js'
import { computeEffectiveThreshold } from '../../src/hooks/adaptive-threshold.js'
import { estimateTokens } from '../../src/core/token-estimator.js'
import { isAbsolute, relative } from '../../src/core/portable-path.js'
import { PREFIX, appendLine, modConfig, tpDir } from './host.js'

export const READ_ACTIONS = ['hook-read']

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function registerRead(on: On): void {
  let savedThisSession = 0

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    try {
      const filePath = String(e.file_path)
      const config = await modConfig($)
      if (config.hooks.mode === 'off' || !isCodeFile(filePath)) return next(e)

      const root = await $.session.root()
      const [realRoot, real] = await Promise.all([
        $.fs.stat(root, { resolve: true }),
        $.fs.stat(filePath, { resolve: true }),
      ])
      if (!inside(realRoot.realPath ?? root, real.realPath ?? filePath)) return next(e)

      const threshold = config.hooks.adaptiveThreshold
        ? computeEffectiveThreshold({
            baseThreshold: config.hooks.denyThreshold,
            sessionSavedTokens: savedThisSession,
            sessionBudgetTokens: config.hooks.adaptiveBudgetTokens ?? 100_000,
            enabled: true,
          })
        : config.hooks.denyThreshold
      const gate = decideReadGate({
        filePath,
        content: String(await $.fs.read(filePath)),
        offset: e.offset ?? null,
        limit: e.limit ?? null,
        threshold,
      })
      if (gate.kind === 'pass') return next(e)

      const pointer = `[token-pilot] ${filePath} has ${gate.lineCount} lines. Use ${PREFIX}smart_read for its structure, ${PREFIX}read_symbol for one symbol, or Read with offset/limit.`
      if (config.hooks.mode === 'advisory') return { deny: pointer }

      const outline = await $.tool.call({ tool: `${PREFIX}smart_read`, path: filePath } as never)
      if (outline.deny !== undefined || outline.isError || !outline.text) return { deny: pointer }

      // Core reads one line, so Claude Code counts the file as read and a later Edit works.
      const ran: any = await next({ ...e, offset: 1, limit: 1 })
      if (ran.deny !== undefined || ran.isError || ran.result?.type !== 'text') return ran

      const header = outlineHeader(relative(root, filePath), gate.lineCount, gate.estTokens, PREFIX)
      const saved = Math.max(0, gate.estTokens - estimateTokens(outline.text))
      savedThisSession += saved
      appendLine($, `${await tpDir($)}/hook-events.jsonl`, JSON.stringify({
        ts: Date.now(), session_id: await $.session.id(), agent_type: null, agent_id: e.agentId ?? null,
        event: 'read_outline', file: filePath, lines: gate.lineCount, estTokens: gate.estTokens,
        summaryTokens: gate.estTokens - saved, savedTokens: saved,
      }))

      return { result: { ...ran.result, file: { ...ran.result.file, content: header + outline.text } } }
    } catch {
      return next(e)
    }
  })
}
```

Check the event name against what the statusline and `session_analytics` sum. Today hook-read writes `event` values that `hooks/tp-statusline.sh` filters on (around lines 160-190). If they filter by event name, use the same name hook-read writes for a deny-enhanced gate, or add `read_outline` to their filters in this task. Then register the hook and add `READ_ACTIONS` to `SERVED`.

- [ ] **Step 4: Run** `npm run test:mod && npx vitest run` → PASS.

- [ ] **Step 5: Live check** — copy a 1500-line file into a scratch project (as in the spike), then:

```bash
claude -p --plugin-dir /home/shahinyanm/www/loom/token-pilot --settings /tmp/tp-off.json --allowedTools "Read" "Edit" --max-turns 6 \
  "Read src/big.ts with no offset or limit and quote its first line. Then Edit src/big.ts replacing 'import { Server } from' with 'import { Server as S } from' and report the result." < /dev/null
```

Expected: the first line starts with `[token-pilot] src/big.ts has`, and the Edit succeeds.

- [ ] **Step 6: Commit** `feat(mod): big code-file Read returns its outline as a normal result`.

---

### Task 10: Agent routing, subagent budgets, and the router false positive

**Files:**
- Create: `hooks/mod/agent.ts`, `hooks/mod/agent.test.ts`, `tests/fixtures/router-long-prompt.txt`
- Modify: `src/core/agent-matcher.ts` (`scoreAgent`, `matchTpAgent`), `src/hooks/pre-task.ts:157-176`, `tests/core/agent-matcher.test.ts`, `hooks/mod/register.ts`

**Interfaces:**
- Produces:
  - `matchTpAgent(description: string, index: AgentIndex, extra?: string)`. Keywords are scored on `description` only; quoted triggers and negatives on `description + extra`.
  - `registerAgent(on)`, `AGENT_ACTIONS = ['hook-pre-task', 'hook-post-task', 'hook-subagent-stop']`.

- [ ] **Step 1: Failing tests**

Create `tests/fixtures/router-long-prompt.txt` with the prompt from the 2026-10-04 incident (the inventory request). It starts "Read-only inventory in the repo /home/shahinyanm/www/loom/token-pilot (TypeScript). I am planning to port the Claude Code hooks to an in-process "mod" environment…" and has about 1700 characters. Copy it from the task-journal entry of `tj-fp61601g4t`, or recreate a prompt of similar length with the words `repo, only, entry, points, modules, how, what, file, write, api`.

In `tests/core/agent-matcher.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { buildAgentIndexFromFiles, matchTpAgent } from "../../src/core/agent-matcher.ts";

const index = buildAgentIndexFromFiles(
  readdirSync("agents").map((fileName) => ({ fileName, body: readFileSync(`agents/${fileName}`, "utf-8") })),
);

it("does not reach high confidence on generic words in a long prompt", () => {
  const prompt = readFileSync("tests/fixtures/router-long-prompt.txt", "utf-8");
  expect(matchTpAgent("Inventory token-pilot hooks", index, prompt)?.confidence ?? "low").toBe("low");
});

it("still reaches high confidence on a quoted trigger in the prompt", () => {
  expect(matchTpAgent("look at this", index, "please review these changes for duplication")?.confidence).toBe("high");
});
```

`hooks/mod/agent.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'

test('notes an over-budget tp-* answer to the caller', async ($, on) => {
  on('env.get', async () => ({ value: undefined }) as any)
  on('session.root', async () => ({ value: '/repo' }) as any)
  on('plugin.root', async () => ({ value: '/plugin' }) as any)
  on('fs.list', async () => ({ value: [{ name: 'tp-run.md' }] }) as any)
  on('fs.read', async () => ({ value: '---\nname: tp-run\ndescription: x\n---\nResponse budget: ~100 tokens\n' }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('tool.call', { tool: 'Agent' }, async () => ({ result: {}, text: 'word '.repeat(2000) }) as any)

  const res: any = await $.tool.call({ tool: 'Agent', subagent_type: 'token-pilot:tp-run', description: 'x', prompt: 'x' } as any)

  expect((res.context ?? []).join('\n')).toMatch(/budget/i)
})
```

If `$.plugin.root` is a property, not an event, the test reads it from the engine. Remove the `plugin.root` stub if `claude plugin test` reports it as unknown.

- [ ] **Step 2: Run** `npx vitest run tests/core/agent-matcher.test.ts && npm run test:mod` → FAIL.

- [ ] **Step 3: Implement**

`src/core/agent-matcher.ts`:

```ts
export function scoreAgent(agent: ParsedAgent, descriptionLower: string, extraLower = ""): number {
  // Keywords come from the short description only. Long prompts are full of
  // generic words ("how", "file", "only") that piled up to a confident wrong
  // match. A prompt still counts through the author's quoted trigger phrases.
  const both = extraLower ? `${descriptionLower} ${extraLower}` : descriptionLower;
  let score = 0;

  for (const trigger of agent.quotedTriggers) if (both.includes(trigger)) score += 2;
  for (const kw of agent.keywords) if (descriptionLower.includes(kw)) score += 1;
  for (const neg of agent.negative) if (both.includes(neg)) score -= 1;

  return score;
}
```

`matchTpAgent(description, index, extra = "")` passes `extra.toLowerCase()` to `scoreAgent`, and computes `hitQuoted` over `description + " " + extra`. In `pre-task.ts`:
- call `matchTpAgent(description, ctx.agentIndex, prompt)` instead of passing `haystack`;
- keep `containsEscape(haystack)`;
- update the v0.50.0 comment above it.

`hooks/mod/agent.ts`:

```ts
import type { On } from 'claude-code'
import { buildAgentIndexFromFiles, bareAgentName, type AgentIndex } from '../../src/core/agent-matcher.js'
import { decidePreTask } from '../../src/hooks/pre-task.js'
import { decideBudgetAdvice, parseAgentBudget } from '../../src/hooks/agent-budget.js'
import { estimateTokens } from '../../src/core/token-estimator.js'
import { parseEnforcementMode } from '../../src/server/enforcement-mode.js'
import { appendLine, readAgentFiles, tpDir, withContext } from './host.js'

export const AGENT_ACTIONS = ['hook-pre-task', 'hook-post-task', 'hook-subagent-stop']

export function registerAgent(on: On): void {
  let files: Array<{ fileName: string; body: string }> | null = null
  let index: AgentIndex | null = null

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    files ??= await readAgentFiles($, `${$.plugin.root}/agents`)
    index ??= buildAgentIndexFromFiles(files)

    const decision = decidePreTask(
      { tool_name: 'Agent', tool_input: { subagent_type: e.subagent_type, description: e.description, prompt: e.prompt } },
      {
        mode: parseEnforcementMode(await $.env.get('TOKEN_PILOT_MODE')),
        agentIndex: index,
        force: (await $.env.get('TOKEN_PILOT_FORCE_SUBAGENTS')) === '1',
        agentNamePrefix: 'token-pilot:',
      },
    )
    if (decision.kind === 'deny') return { deny: decision.reason }

    const ran = await next(e)
    const notes = decision.kind === 'advise' ? [decision.message] : []

    const name = bareAgentName(String(e.subagent_type ?? ''))
    const body = files.find(f => f.fileName === `${name}.md`)?.body
    const budget = body ? parseAgentBudget(body) : null
    if (budget !== null && ran.text) {
      const advice = decideBudgetAdvice({ agentName: name, budget, actualTokens: estimateTokens(ran.text) } as never)
      if (advice?.message) {
        notes.push(advice.message)
        appendLine($, `${await tpDir($)}/over-budget.log`, `${new Date().toISOString()} agent=${name} budget=${budget} actual=${estimateTokens(ran.text)}`)
      }
    }

    return withContext(ran, notes)
  })
}
```

Match the `decideBudgetAdvice` input and result fields to `src/hooks/agent-budget.ts`, and the over-budget.log line to what `appendOverBudgetLog` writes. Read both before writing this file.

Workflow sessions: `decidePreTask` in the command path also appends a workflow budget note when `TOKEN_PILOT_WORKFLOW_ID`, `CLAUDE_CODE_WORKFLOW_ID` or `LOOM_WORKFLOW_ID` is set. The mod does not port that. In `register.ts`, leave `AGENT_ACTIONS` out of `SERVED` when any of those three env vars is set at session start, and skip `registerAgent` then, so the command hooks keep serving workflow runs. Read them with `$.env.get` literals inside `handOff`, and compute `SERVED` there instead of as a constant.

- [ ] **Step 4: Run** `npx vitest run && npm run test:mod` → PASS. The existing `pre-task` tests stay green; the v0.50.0 "review these changes for duplication" case is still `deny`.

- [ ] **Step 5: Commit** — two commits:
  1. `fix: router scores keywords on the description only, so long prompts stop forcing wrong agents`
  2. `feat(mod): agent routing and subagent budgets from the Agent result`

---

### Task 11: Session context as a system-prompt section; notes for the human as toasts

**Files:** Create `hooks/mod/session.ts`, `hooks/mod/session.test.ts`; modify `hooks/mod/register.ts`; possibly `src/hooks/installer.ts` (pure duplicate finder).

**Interfaces:**
- Consumes: `buildReminderMessage`, `profileBannerNote`, `parseAgentEntry` (Task 2), `parseProfileEnv`, `modConfig`, `readAgentFiles`.
- Produces: `sessionSection($): Promise<string | null>` (memoised per load) and `SESSION_ACTIONS = ['hook-session-start', 'hook-bootstrap', 'hook-user-prompt']`.

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from 'claude-code/testing'

test('adds the token-pilot section when our tools are offered', async ($, on) => {
  on('env.get', async () => ({ value: undefined }) as any)
  on('session.root', async () => ({ value: '/repo' }) as any)
  on('fs.read', async () => ({ deny: 'none' }) as any)
  on('fs.list', async () => ({ value: [] }) as any)
  on('prompt.compose', async () => ({ sections: [{ id: 'base', scope: 'shared', text: 'BASE' }] }) as any)

  const out: any = await ($ as any).prompt.compose({
    model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [],
    tools: ['Read', 'mcp__plugin_token-pilot_token-pilot__smart_read'],
  })

  const ours = out.sections.find((s: any) => s.id === 'token-pilot')
  expect(ours?.scope).toBe('session')
  expect(ours?.text).toContain('smart_read')
})
```

- [ ] **Step 2: Run** `npm run test:mod` → FAIL.

- [ ] **Step 3: Implement**

`hooks/mod/session.ts`:

```ts
import { buildReminderMessage, parseAgentEntry, profileBannerNote } from '../../src/hooks/session-context.js'
import { parseProfileEnv } from '../../src/server/tool-profiles.js'
import { join } from '../../src/core/portable-path.js'
import { modConfig, readAgentFiles } from './host.js'

export const SESSION_ACTIONS = ['hook-session-start', 'hook-bootstrap', 'hook-user-prompt']

let section: Promise<string | null> | null = null

/** Built once per load: a stable section keeps the prompt cache warm. */
export function sessionSection($: any): Promise<string | null> {
  section ??= (async () => {
    const config = await modConfig($)
    if (!config.sessionStart.enabled || (await $.env.get('TOKEN_PILOT_BYPASS')) === '1') return null

    const root = await $.session.root()
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const seen = new Set<string>()
    const agents = []
    for (const dir of [join(root, '.claude', 'agents'), join(home, '.claude', 'agents')]) {
      for (const f of await readAgentFiles($, dir)) {
        const entry = parseAgentEntry(f.fileName, f.body)
        if (!seen.has(entry.name)) {
          seen.add(entry.name)
          agents.push(entry)
        }
      }
    }

    const profile = profileBannerNote(parseProfileEnv(await $.env.get('TOKEN_PILOT_PROFILE')))
    return [buildReminderMessage(agents, config.sessionStart.maxReminderTokens), profile].filter(Boolean).join('\n\n')
  })()

  return section
}
```

In `register.ts`, the one `prompt.compose` hook:

```ts
on('prompt.compose', async ($, e, next) => {
  const out = await next(e)
  if (!e.tools.some(t => t.startsWith(PREFIX))) return out

  const text = await sessionSection($).catch(() => null)
  return text ? { sections: [...out.sections, { id: 'token-pilot', scope: 'session' as const, text }] } : out
})
```

Add `SESSION_ACTIONS` to `SERVED`.

Human-facing notes:
- Duplicate hook registrations (`detectDuplicateHookRegistrations`, `src/hooks/installer.ts:687-699`): split it into a pure `findDuplicateRegistrations(files: Array<{ path: string; text: string }>)` and the Node reader. In the mod, read the same three settings files with `$.fs.read` inside `session.start`, and call `$.ui.toast(message)` when there are duplicates.
- Not ported:
  - The subagent-adoption nudge (it reads the whole event log at every start).
  - The bootstrap notes (a plugin always carries its agents, and the MCP server reports a missing ast-index itself).

  Say so in `docs/hooks.md` (Task 14).

- [ ] **Step 4: Run** `npm run test:mod && npx vitest run` → PASS.

- [ ] **Step 5: Live check**

```bash
claude -p --plugin-dir . --settings /tmp/tp-off.json --max-turns 2 \
  "Without using tools: quote the first line of any token-pilot section in your system prompt." < /dev/null
```

Expected: a line from `MANDATORY_BLOCK`, while `grep -c hook-user-prompt` over the session's debug log (`claude --debug`) shows the command hook did not run.

- [ ] **Step 6: Commit** `feat(mod): session guidance as a cached system-prompt section`.

---

### Task 12: Savings in the status area

**Files:** Create `hooks/mod/status.ts`, `hooks/mod/status.test.ts`; modify `hooks/mod/register.ts` (`session.start`).

**Interfaces:** Produces `startStatus($): Promise<void>`.

Reuse `hooks/tp-statusline.sh` as the single savings calculator, so no second implementation exists. Every 20 s the mod runs it with the same JSON payload Claude Code gives a statusLine command, and shows the first line, with ANSI codes stripped, through `$.ui.status`. It stays off when the user's own `statusLine` already runs token-pilot's script, so the numbers don't appear twice.

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from 'claude-code/testing'

test('shows nothing extra when the user statusLine already runs token-pilot', async ($, on) => {
  on('env.get', async () => ({ value: '/home/u' }) as any)
  on('fs.read', async () => ({ value: JSON.stringify({ statusLine: { command: 'sh ~/x/hooks/tp-statusline.sh' } }) }) as any)
  const shown: unknown[] = []
  on('ui.status', async (_$, e) => {
    shown.push(e)
    return { value: undefined } as any
  })

  const { startStatus } = await import('./status.js')
  await startStatus($ as any)

  expect(shown).toEqual([])
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
const ANSI = /\x1b\[[0-9;]*m/g

export async function startStatus($: any): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  try {
    const settings = JSON.parse(String(await $.fs.read(`${home}/.claude/settings.json`)))
    if (/tp-statusline|statusline-chain/.test(String(settings?.statusLine?.command ?? ''))) return
  } catch {
    /* no settings — show ours */
  }

  const script = `${$.plugin.root}/hooks/tp-statusline.sh`
  const tick = async () => {
    const payload = JSON.stringify({ session_id: await $.session.id(), cwd: await $.session.cwd() })
    const run = await $.process.run(['sh', script], { stdin: payload }).catch(() => null)
    $.ui.status(run?.stdout.split('\n')[0].replace(ANSI, '').trim() || undefined)
  }

  await tick()
  $.clock.every(20_000, () => void tick())
}
```

Call `startStatus($)` (not awaited) from the one `session.start` hook.

- [ ] **Step 4: Run** `npm run test:mod` → PASS.

- [ ] **Step 5: Live check** in tmux (the spike method):

```bash
tmux new-session -d -s tpmod -x 160 -y 45 "claude --plugin-dir $PWD --settings /tmp/tp-off.json"
```

Send one prompt that calls `smart_read`, then `tmux capture-pane -t tpmod -p | tail -5`. Expected: a `⚠ token-pilot: [TP saved …]` line. Users whose statusLine runs `tp-statusline.sh` see only their own line.

- [ ] **Step 6: Commit** `feat(mod): savings line in the status area`.

---

### Task 13: `/tp-stats` pane

**Files:** Create `hooks/mod/stats.tsx`, `hooks/mod/stats.test.ts`; modify `hooks/mod/register.ts`.

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from 'claude-code/testing'

test('/tp-stats loads session analytics and opens the pane', async ($, on) => {
  const opened: unknown[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: undefined } as any
  })
  on('tool.call', async () => ({ result: 'x', text: 'Saved 12k tokens' }) as any)

  const out: any = await ($ as any).command.run({ command: 'tp-stats', args: '' })

  expect(out.text).toContain('opened')
  expect(opened.length).toBe(1)
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `hooks/mod/stats.tsx`, following the engine's `examples/pane.tsx`:

```tsx
import type { On } from 'claude-code'
import { PREFIX } from './host.js'

const PANE = 'tp-stats'
let text = 'No data yet.'

export async function registerStatsCommand($: any): Promise<void> {
  await $.command.register({ name: 'tp-stats', description: 'Show token-pilot savings for this session' })
}

export function registerStats(on: On): void {
  on('command.run', { command: 'tp-stats' }, async $ => {
    const r: any = await $.tool.call({ tool: `${PREFIX}session_analytics` } as never)
    text = r.text ?? r.deny ?? 'No data yet.'
    await $.ui.open({ id: PANE, title: 'token-pilot' })

    return { text: 'token-pilot stats opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {text.split('\n').map(line => <Text>{line}</Text>)}
      </Box>
    )
  })
}
```

Call `registerStatsCommand($)` from the one `session.start` hook, and `registerStats(on)` from `register`.

- [ ] **Step 4: Run** `npm run test:mod` → PASS.
- [ ] **Step 5: Live check** in tmux: type `/tp-stats`. Expected: a pane titled `token-pilot` with the analytics text.
- [ ] **Step 6: Commit** `feat(mod): /tp-stats pane`.

---

### Task 14: Docs, changelog, version 1.0.0

**Files:** `docs/hooks.md`, `README.md` (client matrix), `CHANGELOG.md`, `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (2 places), `server.json` (2 places).

- [ ] **Step 1:** Add a "Claude Code mods" section to `docs/hooks.md` covering:
  - which Claude Code versions run the mod (≥ 2.1.275, tested 2.1.289);
  - the hand-off flag and the fallback;
  - each hook's mod behaviour and what improved (from the spec's mapping table);
  - what was not ported (adoption nudge, bootstrap notes, workflow-run agent routing);
  - how to force the command hooks: the user can disable mods or set `TOKEN_PILOT_MOD` empty — verify which works and document only that one.
- [ ] **Step 2:** `CHANGELOG.md` `## 1.0.0`:
  - breaking/visible changes: a big Read returns an outline instead of an error; session guidance moved into the system prompt; the per-turn reminder is gone under the mod; the router scores keywords on the description only;
  - new: status line, `/tp-stats`, faster hooks;
  - unchanged: Codex, npm install-hook.
- [ ] **Step 3:** Set the version to `1.0.0` in every version file listed above. Run `grep -rn "0\.53\.1" package.json .claude-plugin server.json` and expect nothing.
- [ ] **Step 4:** Run `npm run build && npx vitest run && npx tsc --noEmit && npm run test:mod && npm pack --dry-run | tail -3`. All green.
- [ ] **Step 5: Commit** `release: 1.0.0 — Claude Code mods`.

---

### Task 15: Final verification matrix (no publishing)

Run each row and paste the evidence into the PR description draft. The PR itself is created only after the user says so.

| # | Environment | Command | Expected |
| --- | --- | --- | --- |
| 1 | Unit | `npx vitest run` | all green, count ≥ 1507 + new |
| 2 | Types | `npx tsc --noEmit` | clean |
| 3 | Mod engine | `npm run test:mod` | validate passes, ≥ 12 tests pass |
| 4 | CC 2.1.289 + mod | `claude -p --plugin-dir . --settings /tmp/tp-off.json …` Bash `cat`, Read big file, Edit after it, Agent with a long prompt, smart_read from a worktree | refusal text, outline header, Edit ok, no false hard-deny, worktree path |
| 5 | CC 2.1.289, mod disabled | same with the mod switched off (method documented in Task 14) | 0.53.1 behaviour: Read refused with summary, command hooks in `--debug` log |
| 6 | CC 2.1.250 | same commands with the old binary, `DISABLE_AUTOUPDATER=1` | 0.53.1 behaviour, no errors |
| 7 | Interactive | tmux session, `/tp-stats`, one smart_read | status line and pane visible |
| 8 | Codex | `token-pilot install-codex-hook` into a temp `CODEX_HOME`, then one `codex exec` with `cat src/index.ts` | denied as in 0.53.0 |

- [ ] **Step 1:** Run rows 1–8 and save the outputs.
- [ ] **Step 2:** Fix any red row in the task that owns it (TDD), then rerun the whole matrix.
- [ ] **Step 3:** Draft the PR description in chat for the user. Do not publish anything.
