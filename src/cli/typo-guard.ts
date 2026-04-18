/**
 * CLI typo guard — catches obvious mis-typed commands before they fall
 * through to the default `startServer(cliArgs)` branch where the arg is
 * treated as a project root.
 *
 * The bug it prevents: `npx token-pilot install-aents` (missing 'g')
 * silently became a projectRoot=install-aents MCP server launch, which
 * then created stray `install-aents/.claude/settings.json` directories.
 *
 * Heuristic:
 *   - If the first arg looks command-like (all-lowercase kebab, no path
 *     separators, no absolute/relative path markers)
 *   - AND it's not in the known-commands allow-list
 *   - AND it doesn't resolve to an existing directory
 *   - → treat as typo: print an error + suggest the closest command.
 *
 * Everything else passes through untouched — a real project root like
 * `/home/user/my-project` or `./subdir` goes to startServer as before.
 */

import { existsSync, statSync } from "node:fs";

export const KNOWN_COMMANDS = [
  "hook-read",
  "hook-edit",
  "hook-post-bash",
  "hook-session-start",
  "install-hook",
  "uninstall-hook",
  "install-ast-index",
  "doctor",
  "bless-agents",
  "unbless-agents",
  "install-agents",
  "uninstall-agents",
  "stats",
  "save-doc",
  "list-docs",
  "init",
  "--version",
  "-v",
  "--help",
  "-h",
] as const;

const COMMAND_LIKE_RE = /^[a-z]+(-[a-z]+)+$/;

function looksLikeCommand(arg: string): boolean {
  if (!arg) return false;
  if (arg.startsWith("-") && !arg.startsWith("--")) return false;
  if (arg.includes("/") || arg.includes("\\")) return false;
  if (arg === "." || arg === "..") return false;
  return COMMAND_LIKE_RE.test(arg);
}

function existsAsDir(arg: string): boolean {
  try {
    return existsSync(arg) && statSync(arg).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Levenshtein distance — cheap enough on 20-item allow-list.
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export interface TypoGuardResult {
  kind: "pass-through" | "typo";
  suggestion?: string;
  message?: string;
}

export function checkForTypo(firstArg: string | undefined): TypoGuardResult {
  if (!firstArg) return { kind: "pass-through" };
  if ((KNOWN_COMMANDS as readonly string[]).includes(firstArg)) {
    return { kind: "pass-through" };
  }
  if (!looksLikeCommand(firstArg)) return { kind: "pass-through" };
  if (existsAsDir(firstArg)) return { kind: "pass-through" };

  // Find closest match among command-like known commands.
  let best = "";
  let bestDistance = Infinity;
  for (const cmd of KNOWN_COMMANDS) {
    if (cmd.startsWith("-")) continue; // skip flags for suggestion
    const d = distance(firstArg, cmd);
    if (d < bestDistance) {
      bestDistance = d;
      best = cmd;
    }
  }

  const suggestion = bestDistance <= 3 ? best : undefined;
  const message = suggestion
    ? `Unknown command "${firstArg}". Did you mean "${suggestion}"?`
    : `Unknown command "${firstArg}". Run "token-pilot --help" for the full list.`;

  return { kind: "typo", suggestion, message };
}
