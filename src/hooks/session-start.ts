/**
 * SessionStart reminder hook — Component 2 of the enforcement layer.
 *
 * On every session start / /clear / /compact, emits a compact additionalContext
 * block containing the mandatory-tool rules and a list of tp-* subagents found
 * in the project and user agent directories.
 *
 * Output contract: one JSON line on stdout, or exit 0 silent.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectDuplicateHookRegistrations } from "./installer.js";
import { loadLatestSnapshot } from "./../handlers/session-snapshot-persist.js";
import { loadEvents, type HookEvent } from "../core/event-log.js";
import { parseProfileEnv, type ToolProfile } from "../server/tool-profiles.js";
import {
  buildReminderMessage,
  buildSubagentAdoptionNudge,
  duplicateWarning,
  parseAgentEntry,
  profileBannerNote,
  snapshotLine,
  type AgentEntry,
} from "./session-context.js";

export {
  buildReminderMessage,
  buildSubagentAdoptionNudge,
  parseAgentEntry,
  profileBannerNote,
};
export type { AgentEntry };


// ─── Types ───────────────────────────────────────────────────────────────────


export interface SessionStartConfig {
  enabled: boolean;
  showStats: boolean;
  maxReminderTokens: number;
}

export interface HandleSessionStartOptions {
  projectRoot: string;
  homeDir: string;
  sessionStartConfig: SessionStartConfig;
  /**
   * Which client this hook is serving. Codex validates the returned
   * `hookSpecificOutput` and fails the hook on a key it does not know,
   * so Claude Code's extensions are left out there.
   */
  client?: "claude-code" | "codex";
}

// ─── Agent scanner (subtask 2.2) ─────────────────────────────────────────────


/**
 * Scan one agents directory for tp-*.md files and return parsed entries.
 */
async function scanDir(dir: string): Promise<AgentEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const agents: AgentEntry[] = [];
  for (const filename of names) {
    if (!filename.startsWith("tp-") || !filename.endsWith(".md")) continue;
    try {
      const content = await readFile(join(dir, filename), "utf-8");
      agents.push(parseAgentEntry(filename, content));
    } catch {
      // Skip unreadable files
    }
  }
  return agents;
}

/**
 * Scan ~/.claude/agents/ and ./.claude/agents/ for tp-*.md agent definitions.
 * Project directory takes precedence; duplicates (by name) are dropped.
 *
 * @param projectRoot - absolute path to the project root
 * @param homeDir - home directory (injected for testability; defaults to os.homedir())
 */
export async function scanAgents(
  projectRoot: string,
  homeDir: string,
): Promise<AgentEntry[]> {
  const projectAgentsDir = join(projectRoot, ".claude", "agents");
  const homeAgentsDir = join(homeDir, ".claude", "agents");

  const [projectAgents, homeAgents] = await Promise.all([
    scanDir(projectAgentsDir),
    scanDir(homeAgentsDir),
  ]);

  // Merge: project agents first; home agents fill in names not already present
  const seen = new Set<string>();
  const merged: AgentEntry[] = [];
  for (const agent of [...projectAgents, ...homeAgents]) {
    if (!seen.has(agent.name)) {
      seen.add(agent.name);
      merged.push(agent);
    }
  }
  return merged;
}


export async function handleSessionStart(
  opts: HandleSessionStartOptions,
): Promise<string | null> {
  try {
    if (!opts.sessionStartConfig.enabled) {
      return null;
    }

    const agents = await scanAgents(opts.projectRoot, opts.homeDir);
    let message = buildReminderMessage(
      agents,
      opts.sessionStartConfig.maxReminderTokens,
    );
    // Prepend a profile caveat when a trimmed surface hides referenced tools.
    message =
      profileBannerNote(parseProfileEnv(process.env.TOKEN_PILOT_PROFILE)) +
      message;

    // TP-340: surface a fresh snapshot so the new session can resume.
    const snap = await loadLatestSnapshot(opts.projectRoot);
    const resume = snap ? snapshotLine(snap.body, snap.ageMs) : null;
    if (resume) message += `\n\n${resume}`;

    // v0.32.0 — subagent adoption nudge. Reads recent Task telemetry
    // from hook-events.jsonl; when the main thread is picking
    // general-purpose on routable work, surface a one-liner so the
    // user / agent sees the miss rate without needing `stats --tasks`.
    try {
      const events = await loadEvents(opts.projectRoot);
      const nudge = buildSubagentAdoptionNudge(events, Date.now());
      if (nudge) message += `\n\n${nudge}`;
    } catch {
      /* silent — telemetry nudge is strictly opt-in */
    }

    // v0.48.0 — flag a token-pilot that is registered more than once.
    // As a plugin, hooks/hooks.json already registers every hook; a
    // leftover entry in some settings.json is a second registration, so
    // Claude Code fires each hook once per copy — several node processes
    // per Read, several event-log rows per subagent. `installHook`
    // refuses to write a duplicate, but that guard only runs when the
    // user invokes `install-hook`; entries written before the plugin was
    // enabled survive untouched. This lives here rather than in
    // hook-bootstrap because bootstrap carries `once: true` and the
    // people who need the warning ran it long ago.
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      try {
        const report = await detectDuplicateHookRegistrations([
          resolve(opts.homeDir, ".claude", "settings.json"),
          resolve(opts.projectRoot, ".claude", "settings.json"),
          resolve(opts.projectRoot, ".claude", "settings.local.json"),
        ]);
        const warning = duplicateWarning(report.sources);
        if (warning) message += `\n\n${warning}`;
      } catch {
        /* silent — a stale-install warning must never break startup */
      }
    }

    // v0.35.0 — watchPaths is an undocumented SessionStart return key
    // (surfaced by reverse-engineering @anthropic-ai/claude-code@2.1.87).
    // Claude Code watches these paths and re-fires FileChanged so a
    // second active session picks up new snapshots / errors emitted by
    // another worker without manual polling. Additive — older Claude
    // Code versions ignore the key.
    const watchPaths = [
      ".token-pilot/snapshots/latest.md",
      ".token-pilot/hook-events.jsonl",
    ];

    // v0.41.1 — sessionTitle removed. v0.36.0 set the window/tab title
    // to `[TP] Nk saved`, but `sessionTitle` OVERWRITES Claude Code's
    // own session name — an intrusive clobber users (rightly) disliked.
    // The cumulative-savings display belongs in the additive statusline
    // badge (hooks/tp-statusline.sh), the same non-intrusive channel
    // caveman uses — it sits alongside the session name instead of
    // replacing it. Workflow progress, likewise, can ride the
    // statusline (tp-statusline.sh reads the active workflow) rather
    // than hijacking the title.

    // Measured on Codex 0.156: with `watchPaths` present every start
    // reports "SessionStart Failed"; the identical payload without it
    // completes. The key is a Claude Code extension, so it ships only there.
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
        ...(opts.client === "codex" ? {} : { watchPaths }),
      },
    };

    return JSON.stringify(output);
  } catch {
    // Fail-safe: never block the session
    return null;
  }
}
