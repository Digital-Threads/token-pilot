/**
 * SessionStart hook. On Claude Code the model gets a line only when a fresh
 * snapshot is there to resume from: each tool's own description says when
 * to use it, so no rule block or agent list goes into the context. What the
 * person has to fix goes to them as a systemMessage. Codex reads code
 * through the shell and keeps its tool block.
 *
 * Output contract: one JSON line on stdout, or exit 0 silent.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectDuplicateHookRegistrations } from "./installer.js";
import { loadLatestSnapshot } from "./../handlers/session-snapshot-persist.js";
import {
  CODEX_BLOCK,
  duplicateWarning,
  isLegacyAgent,
  legacyAgentsWarning,
  snapshotLine,
} from "./session-context.js";

export interface SessionStartConfig {
  enabled: boolean;
  showStats: boolean;
  maxReminderTokens: number;
}

export interface HandleSessionStartOptions {
  projectRoot: string;
  homeDir: string;
  sessionStartConfig: SessionStartConfig;
  /** The plugin's root (CLAUDE_PLUGIN_ROOT), set when running as the plugin. */
  pluginRoot?: string;
  /** Where Claude Code reads user agents: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`. */
  userAgentsDir?: string;
  /**
   * Which client this hook is serving. Codex validates the returned
   * `hookSpecificOutput` and fails the hook on a key it does not know,
   * so Claude Code's extensions are left out there.
   */
  client?: "claude-code" | "codex";
}

/** tp-*.md files in `dir` that list only the npm server's tool names. */
async function countLegacyAgents(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const name of names) {
    if (!name.startsWith("tp-") || !name.endsWith(".md")) continue;
    try {
      if (isLegacyAgent(await readFile(join(dir, name), "utf-8"))) count++;
    } catch {
      /* unreadable — not ours to judge */
    }
  }

  return count;
}

/** Notes for the person on a plugin install: duplicate hooks, old agent copies. */
async function pluginNotes(opts: HandleSessionStartOptions): Promise<string[]> {
  const notes: string[] = [];

  // v0.48.0 — as a plugin, hooks/hooks.json already registers every hook;
  // a leftover entry in some settings.json fires each hook once per copy.
  try {
    const report = await detectDuplicateHookRegistrations([
      resolve(opts.homeDir, ".claude", "settings.json"),
      resolve(opts.projectRoot, ".claude", "settings.json"),
      resolve(opts.projectRoot, ".claude", "settings.local.json"),
    ]);
    const warning = duplicateWarning(report.sources);
    if (warning) notes.push(warning);
  } catch {
    /* a stale-install warning must never break startup */
  }

  const userDir = opts.userAgentsDir ?? join(opts.homeDir, ".claude", "agents");
  const projectDir = join(opts.projectRoot, ".claude", "agents");
  const legacy = legacyAgentsWarning([
    { dir: userDir, count: await countLegacyAgents(userDir), scope: "user" },
    { dir: projectDir, count: await countLegacyAgents(projectDir), scope: "project" },
  ]);
  if (legacy) notes.push(legacy);

  return notes;
}

export async function handleSessionStart(
  opts: HandleSessionStartOptions,
): Promise<string | null> {
  try {
    if (!opts.sessionStartConfig.enabled) return null;

    const codex = opts.client === "codex";
    const lines: string[] = codex ? [CODEX_BLOCK] : [];

    // TP-340: surface a fresh snapshot so the new session can resume.
    const snap = await loadLatestSnapshot(opts.projectRoot);
    const resume = snap ? snapshotLine(snap.body, snap.ageMs) : null;
    if (resume) lines.push(resume);

    const notes = !codex && opts.pluginRoot ? await pluginNotes(opts) : [];

    // v0.35.0 — watchPaths is an undocumented SessionStart return key:
    // Claude Code watches these paths and re-fires FileChanged so a second
    // active session picks up new snapshots. Measured on Codex 0.156: with
    // `watchPaths` present every start reports "SessionStart Failed", so
    // the key ships only on Claude Code.
    const watchPaths = [
      ".token-pilot/snapshots/latest.md",
      ".token-pilot/hook-events.jsonl",
    ];

    return JSON.stringify({
      ...(notes.length > 0 ? { systemMessage: notes.join("\n\n") } : {}),
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        ...(lines.length > 0 ? { additionalContext: lines.join("\n\n") } : {}),
        ...(codex ? {} : { watchPaths }),
      },
    });
  } catch {
    // Fail-safe: never block the session
    return null;
  }
}
