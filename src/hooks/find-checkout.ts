/**
 * Node half of the MCP path hook (see mcp-path.ts), kept apart so the
 * decision itself stays free of Node for the Claude Code mod.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The git checkout `dir` belongs to: the nearest ancestor holding a `.git`
 * entry — a directory for the main checkout, a file for a linked worktree,
 * which is exactly the distinction this hook needs.
 */
/**
 * The project a command hook serves: Claude Code's CLAUDE_PROJECT_DIR, else
 * the checkout around cwd, else cwd. Never cwd first — after a `cd src` it
 * is a subdirectory, and config, telemetry and the Read gate's boundary
 * would follow it there.
 */
export function hookProjectRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): string {
  return env.CLAUDE_PROJECT_DIR || findCheckout(cwd) || cwd;
}

export function findCheckout(dir: string): string | null {
  let current = resolve(dir);

  for (;;) {
    if (existsSync(join(current, ".git"))) return current;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
