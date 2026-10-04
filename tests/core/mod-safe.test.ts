/**
 * A Claude Code mod runs without Node: no node:* modules, no npm packages,
 * no `process`. One such dependency anywhere on the mod's import graph makes
 * the mod fail to load, or makes a hook throw `process is not defined` —
 * which is exactly what core/tool-names.ts did in the 2026-10-04 spike.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MOD_ENTRIES = [
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
  "src/hooks/mcp-path.ts",
  "src/core/agent-matcher.ts",
  "src/hooks/pre-task.ts",
  "src/hooks/agent-budget.ts",
  "src/hooks/session-context.ts",
  "src/hooks/read-gate.ts",
  "src/config/resolve.ts",
  "src/core/hook-event.ts",
  "src/server/tool-profiles.ts",
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
