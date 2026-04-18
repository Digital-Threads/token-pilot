/**
 * v0.26.0 — AI-client detection for install-agents.
 *
 * `tp-*` subagents are a Claude Code concept: `.md` files in
 * `~/.claude/agents/` with `tools:` frontmatter, invoked via the `Task`
 * tool. Other clients (Cursor, Codex CLI, Gemini CLI, Cline) read MCP
 * tool descriptions directly and have no subagent surface — they still
 * get our MCP tools + Read hook, but the 19 tp-* delegates sit idle.
 *
 * This detector tries to recognise the active client from env vars and
 * on-disk config directories, so `install-agents` can warn non-Claude
 * users before silently creating a dir nothing will read.
 *
 * Note: detection is best-effort. It returns the *most likely* client or
 * "unknown" — never throws, never asks the user. A false "claude-code"
 * result only costs one unused directory; a false "cursor" would print a
 * misleading warning. We err on the side of "claude-code" when in doubt.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

export type DetectedClient =
  | "claude-code"
  | "cursor"
  | "codex"
  | "gemini"
  | "cline"
  | "unknown";

export interface DetectionResult {
  client: DetectedClient;
  source: string;
  subagentsSupported: boolean;
}

/**
 * Identify which AI client is likely running token-pilot, by inspecting
 * env vars first (cheapest) then filesystem markers.
 *
 * @param homeDir       user's home directory (injected for tests)
 * @param projectRoot   current project root (injected for tests)
 * @param env           process.env (injected for tests)
 */
export async function detectClient(
  homeDir: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectionResult> {
  // 1. Env-var signals — fastest, most reliable when set.
  if (env.CLAUDE_PLUGIN_ROOT) {
    return {
      client: "claude-code",
      source: "CLAUDE_PLUGIN_ROOT env",
      subagentsSupported: true,
    };
  }
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) {
    return {
      client: "cursor",
      source: "CURSOR_* env",
      subagentsSupported: false,
    };
  }
  if (env.GEMINI_CLI === "1" || env.GOOGLE_CLOUD_CODE === "1") {
    return {
      client: "gemini",
      source: "GEMINI_* env",
      subagentsSupported: false,
    };
  }
  if (env.OPENAI_CODEX === "1" || env.CODEX_MODE) {
    return {
      client: "codex",
      source: "CODEX_* env",
      subagentsSupported: false,
    };
  }

  // 2. Filesystem signals. Order matters — check the ones with the
  //    strongest on-disk footprint first.
  const markers: Array<[string, string, DetectedClient, boolean]> = [
    [
      join(homeDir, ".claude", "agents"),
      "~/.claude/agents/",
      "claude-code",
      true,
    ],
    [join(homeDir, ".claude"), "~/.claude/", "claude-code", true],
    [join(projectRoot, ".cursor"), ".cursor/", "cursor", false],
    [join(homeDir, ".cursor"), "~/.cursor/", "cursor", false],
    [join(homeDir, ".codex"), "~/.codex/", "codex", false],
    [join(homeDir, ".gemini"), "~/.gemini/", "gemini", false],
    [join(projectRoot, ".gemini"), ".gemini/", "gemini", false],
  ];

  for (const [path, source, client, subagentsSupported] of markers) {
    try {
      await fs.access(path);
      return { client, source, subagentsSupported };
    } catch {
      /* try next */
    }
  }

  // 3. Nothing recognised — assume Claude Code (safest default: the user
  //    explicitly ran `install-agents`, so they likely have Claude Code
  //    but haven't used it yet, or ran via CI where env vars are sparse).
  return {
    client: "unknown",
    source: "no markers found",
    subagentsSupported: true,
  };
}

/**
 * Compose a human-readable warning for `install-agents` to print when
 * the detected client doesn't support subagents. Null when it does.
 */
export function nonClaudeClientWarning(
  detection: DetectionResult,
): string | null {
  if (detection.subagentsSupported) return null;
  return (
    `[token-pilot] Detected ${detection.client} (${detection.source}).\n` +
    `[token-pilot] tp-* subagents are a Claude Code concept and will NOT be\n` +
    `[token-pilot] auto-invoked in ${detection.client}. Your MCP tools and Read hook\n` +
    `[token-pilot] still work fully. If you meant to install for Claude Code (multiple\n` +
    `[token-pilot] AI clients coexist), pass --scope=user explicitly and re-run.`
  );
}
