import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export interface HookInstallResult {
  installed: boolean;
  fatal: boolean;
  message: string;
}

export interface HookUninstallResult {
  removed: boolean;
  fatal: boolean;
  message: string;
}

export interface HookInstallOptions {
  /** Absolute path to the entry script (dist/index.js). When provided, hooks use absolute paths instead of bare "token-pilot". */
  scriptPath?: string;
  /** Absolute path to the node binary. Defaults to process.execPath. */
  nodeExecPath?: string;
}

/**
 * Build hook command that works in any shell (/bin/sh, bash, etc.)
 * Uses absolute paths to node + script to avoid PATH/nvm issues.
 * Falls back to bare "token-pilot" only for manual CLI installs.
 */
function buildHookCommand(
  action: string,
  options?: HookInstallOptions,
): string {
  if (options?.scriptPath) {
    const node = options.nodeExecPath || process.execPath;
    return `${node} ${options.scriptPath} ${action}`;
  }
  return `token-pilot ${action}`;
}

// v0.34.0 added a `buildHookArgs()` companion that emitted an
// `args: string[]` field alongside `command`. The intent was to take
// advantage of Claude Code's new direct-spawn schema, but real
// installs hit ENOENT because Claude Code does NOT expand
// `${CLAUDE_PLUGIN_ROOT}` inside `args` array elements. The literal
// `${CLAUDE_PLUGIN_ROOT}/dist/index.js` then went to posix_spawn as
// a real path and bounced. v0.34.1 dropped the helper entirely and
// kept `command`-only emission. Re-introduce only when Claude Code
// docs confirm the env-expansion rules for `args`.

/**
 * Detect a stale token-pilot hook command — one that points at a
 * pinned npx-cache snapshot (`npx/_npx/<hash>/...`) or any other
 * version-pinned path that won't follow plugin upgrades.
 *
 * v0.33.0 fix: users who ran `npx token-pilot init` early on got
 * settings.json entries with literal `~/.npm/_npx/<hash>/...` paths.
 * When the npx cache rotates or token-pilot publishes a new minor,
 * those entries silently call the old binary, missing every hook
 * shipped after install (e.g. v0.31.0 Task hooks). Removing the
 * stale entry lets the next install or the bundled plugin's
 * `hooks/hooks.json` (CLAUDE_PLUGIN_ROOT) take over.
 */
export function isStaleTokenPilotHookCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false;
  if (!cmd.includes("token-pilot")) return false;
  // npm/npx cache hash — always stale (will rotate)
  if (/\/_npx\/[0-9a-f]+\//.test(cmd)) return true;
  // Pinned plugin-cache version path — old version that may not
  // contain a hook handler the new settings entry references.
  // Match `/plugins/cache/token-pilot/token-pilot/<version>/`.
  const pinned = cmd.match(
    /\/plugins\/cache\/token-pilot\/token-pilot\/([^/]+)\//,
  );
  if (pinned) {
    // The plugin runtime always uses ${CLAUDE_PLUGIN_ROOT} which
    // resolves to the *current* version dir. A literal version in
    // the path means someone wrote it from a CLI that captured the
    // dir at install time — stale by definition.
    return true;
  }
  return false;
}

/**
 * Helper — build the canonical `{type, command}` pair for one hook
 * action so emit stays uniform across every matcher.
 *
 * v0.34.0 introduced an `args: string[]` field alongside `command` to
 * adopt Claude Code's new direct-spawn schema, but that path caused
 * ENOENT on real installs because the new spawn skips shell expansion
 * and Claude Code does NOT interpolate `${CLAUDE_PLUGIN_ROOT}` inside
 * `args` array elements (only inside `command` strings). v0.34.1
 * reverts: shell-expanded `command` remains the safe, portable form
 * for every Claude Code version we know of. When Claude Code docs
 * confirm the env-expansion rules for `args`, we can revisit.
 *
 * v0.35.0 — `extras` lets callers attach undocumented Claude Code
 * fields surfaced by reverse-engineering the 2.1.87 source:
 *   - `async: true`     — non-blocking; ideal for telemetry-only
 *                         PostToolUse hooks that just log events
 *   - `once: true`      — runs exactly once per project, auto-removes
 *                         on success; for first-session bootstrap
 *   - `statusMessage`   — UI hint while the hook runs
 * All are additive and ignored by older Claude Code versions.
 */
function hookEntry(
  action: string,
  options?: HookInstallOptions,
  extras: Record<string, unknown> = {},
) {
  return {
    type: "command" as const,
    command: buildHookCommand(action, options),
    ...extras,
  };
}

function createHookConfig(options?: HookInstallOptions) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Read",
          hooks: [hookEntry("hook-read", options)],
        },
        {
          matcher: "Edit",
          hooks: [hookEntry("hook-edit", options)],
        },
        {
          matcher: "MultiEdit",
          hooks: [hookEntry("hook-edit", options)],
        },
        {
          matcher: "Bash",
          hooks: [hookEntry("hook-pre-bash", options)],
        },
        {
          matcher: "Grep",
          hooks: [hookEntry("hook-pre-grep", options)],
        },
        {
          matcher: "Task",
          hooks: [hookEntry("hook-pre-task", options)],
        },
      ],
      SessionStart: [
        {
          hooks: [
            // v0.35.0 — once-only bootstrap (project setup hints)
            hookEntry("hook-bootstrap", options, {
              once: true,
              statusMessage: "Bootstrapping token-pilot...",
            }),
          ],
        },
        {
          hooks: [hookEntry("hook-session-start", options)],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          // v0.35.0 — async: true keeps the advisory off the hot path.
          // post-bash writes NO telemetry (advisory-only), so detached
          // execution is safe here.
          hooks: [hookEntry("hook-post-bash", options, { async: true })],
        },
        {
          matcher: "Task",
          // v0.39.2 — post-task MUST run synchronously. It writes the
          // `event:"task"` record via appendEvent (mkdir + stat +
          // appendFile). Under `async: true` Claude Code fires the hook
          // detached and may reap the process before those writes flush.
          // Kept as a secondary path; v0.39.3 probe showed it does not
          // fire on current Claude Code (see SubagentStop below).
          hooks: [hookEntry("hook-post-task", options)],
        },
      ],
      // v0.40.0 — SubagentStop is the canonical, reliably-firing
      // subagent-completion event. PostToolUse:Task proved non-firing
      // for the dispatch tool; SubagentStop is where the task adoption
      // signal is actually captured. Synchronous (writes telemetry).
      SubagentStop: [
        {
          hooks: [hookEntry("hook-subagent-stop", options)],
        },
      ],
    },
  };
}

/**
 * Install Token Pilot hook into Claude Code settings.
 * Creates or updates .claude/settings.json with PreToolUse hook.
 */
export async function installHook(
  projectRoot: string,
  options?: HookInstallOptions,
): Promise<HookInstallResult> {
  // Skip auto-install when running as a Claude Code plugin —
  // the plugin system already registers hooks via hooks/hooks.json
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return {
      installed: false,
      fatal: false,
      message: "Running as plugin — hooks registered via plugin system.",
    };
  }

  const settingsPath = resolve(projectRoot, ".claude", "settings.json");
  const hookConfig = createHookConfig(options);

  try {
    // Ensure .claude dir exists
    await mkdir(dirname(settingsPath), { recursive: true });

    let settings: Record<string, any> = {};

    // Try to read existing settings
    try {
      const raw = await readFile(settingsPath, "utf-8");
      try {
        settings = JSON.parse(raw);
      } catch {
        // File exists but has invalid JSON — don't destroy it
        return {
          installed: false,
          fatal: true,
          message: `Settings file exists but contains invalid JSON: ${settingsPath}. Fix it manually before installing hooks.`,
        };
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        return {
          installed: false,
          fatal: true,
          message: `Cannot read settings: ${err?.message ?? err}`,
        };
      }
      // ENOENT — file doesn't exist, start fresh
    }

    // Check which Token Pilot hooks already exist
    const existingHooks = settings.hooks?.PreToolUse;
    const isTokenPilotHook = (h: any) =>
      h.hooks?.some((hook: any) => hook.command?.includes("token-pilot"));

    if (Array.isArray(existingHooks)) {
      // Remove old broken hooks (bare "token-pilot" without absolute path)
      // OR stale npx-cache / pinned-version paths (v0.33.0)
      // and replace with working ones using absolute paths.
      const oldBrokenHooks = existingHooks.filter(
        (h: any) =>
          isTokenPilotHook(h) &&
          h.hooks?.some(
            (hook: any) =>
              hook.command?.match(/^token-pilot\s/) ||
              isStaleTokenPilotHookCommand(hook.command),
          ),
      );

      if (oldBrokenHooks.length > 0 && options?.scriptPath) {
        // Remove old broken hooks, will re-add with absolute paths below
        settings.hooks.PreToolUse = existingHooks.filter(
          (h: any) => !isTokenPilotHook(h),
        );
      } else {
        const hasRead = existingHooks.some(
          (h: any) => h.matcher === "Read" && isTokenPilotHook(h),
        );
        const hasEdit = existingHooks.some(
          (h: any) => h.matcher === "Edit" && isTokenPilotHook(h),
        );

        const hasSessionStart =
          Array.isArray(settings.hooks?.SessionStart) &&
          settings.hooks.SessionStart.some(isTokenPilotHook);

        // v0.25.0: check each PostToolUse matcher separately. Previously
        // "any token-pilot hook in PostToolUse" counted the whole section
        // as installed, so v0.21 users (Bash matcher only) missed the
        // Task matcher added in v0.23 and their budget watchdog stayed
        // silent. The required matchers are exactly what createHookConfig
        // ships — derive from there so this stays in sync automatically.
        const requiredPostMatchers = hookConfig.hooks.PostToolUse.map(
          (h) => h.matcher,
        );
        const postMatchers = Array.isArray(settings.hooks?.PostToolUse)
          ? settings.hooks.PostToolUse.filter(isTokenPilotHook).map(
              (h: any) => h.matcher,
            )
          : [];
        const hasAllPostMatchers = requiredPostMatchers.every((m) =>
          postMatchers.includes(m),
        );

        if (hasRead && hasEdit && hasSessionStart && hasAllPostMatchers) {
          return {
            installed: false,
            fatal: false,
            message: "Token Pilot hooks already installed.",
          };
        }
      }

      // Add missing PreToolUse hooks
      for (const hookDef of hookConfig.hooks.PreToolUse) {
        const exists = settings.hooks.PreToolUse.some(
          (h: any) => h.matcher === hookDef.matcher && isTokenPilotHook(h),
        );
        if (!exists) {
          settings.hooks.PreToolUse.push(hookDef);
        }
      }
    } else {
      // Create hooks section
      if (!settings.hooks) settings.hooks = {};
      settings.hooks.PreToolUse = hookConfig.hooks.PreToolUse;
    }

    // Install SessionStart hook idempotently
    const existingSessionStart = settings.hooks?.SessionStart;
    const hasSessionStart =
      Array.isArray(existingSessionStart) &&
      existingSessionStart.some(isTokenPilotHook);
    if (!hasSessionStart) {
      if (!settings.hooks) settings.hooks = {};
      if (!Array.isArray(settings.hooks.SessionStart)) {
        settings.hooks.SessionStart = [];
      }
      settings.hooks.SessionStart.push(...hookConfig.hooks.SessionStart);
    }

    // Install PostToolUse hooks idempotently — per-matcher check.
    // v0.25.0: earlier code treated the whole section as one unit, which
    // meant users installed in v0.21 (only Bash matcher) never received
    // the Task matcher added in v0.23. That silently broke the budget
    // watchdog for anyone upgrading from an older version. Now we check
    // each matcher individually, same as PreToolUse.
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PostToolUse)) {
      settings.hooks.PostToolUse = [];
    }
    for (const hookDef of hookConfig.hooks.PostToolUse) {
      const exists = settings.hooks.PostToolUse.some(
        (h: any) => h.matcher === hookDef.matcher && isTokenPilotHook(h),
      );
      if (!exists) {
        settings.hooks.PostToolUse.push(hookDef);
      }
    }

    // v0.40.0 — SubagentStop (canonical subagent-completion capture).
    // Installed idempotently, same pattern as SessionStart.
    if (Array.isArray((hookConfig.hooks as any).SubagentStop)) {
      if (!Array.isArray(settings.hooks.SubagentStop)) {
        settings.hooks.SubagentStop = [];
      }
      const hasSubagentStop =
        settings.hooks.SubagentStop.some(isTokenPilotHook);
      if (!hasSubagentStop) {
        settings.hooks.SubagentStop.push(
          ...(hookConfig.hooks as any).SubagentStop,
        );
      }
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    return {
      installed: true,
      fatal: false,
      message: `Hooks installed at ${settingsPath}. Token Pilot will block unbounded Read on large code files and suggest read_for_edit before Edit.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      installed: false,
      fatal: true,
      message: `Failed to install hook: ${msg}`,
    };
  }
}

/**
 * Remove Token Pilot hook from Claude Code settings.
 */
export async function uninstallHook(
  projectRoot: string,
): Promise<HookUninstallResult> {
  const settingsPath = resolve(projectRoot, ".claude", "settings.json");

  try {
    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    const hasPreToolUse = !!settings.hooks?.PreToolUse;
    const hasSessionStart = !!settings.hooks?.SessionStart;
    const hasPostToolUse = !!settings.hooks?.PostToolUse;
    const hasSubagentStop = !!settings.hooks?.SubagentStop;
    if (
      !hasPreToolUse &&
      !hasSessionStart &&
      !hasPostToolUse &&
      !hasSubagentStop
    ) {
      return { removed: false, fatal: false, message: "No hooks to remove." };
    }

    const isTokenPilotHook = (h: any) =>
      h.hooks?.some((hook: any) => hook.command?.includes("token-pilot"));

    if (Array.isArray(settings.hooks?.PreToolUse)) {
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
        (h: any) => !isTokenPilotHook(h),
      );
      if (settings.hooks.PreToolUse.length === 0) {
        delete settings.hooks.PreToolUse;
      }
    }

    if (Array.isArray(settings.hooks?.SessionStart)) {
      settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
        (h: any) => !isTokenPilotHook(h),
      );
      if (settings.hooks.SessionStart.length === 0) {
        delete settings.hooks.SessionStart;
      }
    }

    if (Array.isArray(settings.hooks?.PostToolUse)) {
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
        (h: any) => !isTokenPilotHook(h),
      );
      if (settings.hooks.PostToolUse.length === 0) {
        delete settings.hooks.PostToolUse;
      }
    }

    if (Array.isArray(settings.hooks?.SubagentStop)) {
      settings.hooks.SubagentStop = settings.hooks.SubagentStop.filter(
        (h: any) => !isTokenPilotHook(h),
      );
      if (settings.hooks.SubagentStop.length === 0) {
        delete settings.hooks.SubagentStop;
      }
    }

    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    return {
      removed: true,
      fatal: false,
      message: "Token Pilot hook removed.",
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        removed: false,
        fatal: false,
        message: "Settings file not found.",
      };
    }
    if (err instanceof SyntaxError) {
      return {
        removed: false,
        fatal: true,
        message: `Settings file contains invalid JSON: ${settingsPath}. Fix it manually before uninstalling hooks.`,
      };
    }
    return {
      removed: false,
      fatal: true,
      message: `Failed to process settings: ${err?.message ?? err}`,
    };
  }
}

// ─── v0.33.0 migration ────────────────────────────────────────────────

export interface CleanStaleResult {
  scanned: string[];
  cleaned: string[];
  staleEntriesRemoved: number;
  message: string;
}

/**
 * Scan a settings.json (user-level or project-level) and remove every
 * token-pilot hook entry whose command points at a pinned npx-cache
 * snapshot or a literal plugin-cache version path. The plugin's bundled
 * `hooks/hooks.json` (resolved through `${CLAUDE_PLUGIN_ROOT}` at
 * runtime) supersedes them.
 *
 * Pure-ish: writes only when something changed. Never throws — bad JSON
 * or missing file are reported in the result so callers (CLI, init)
 * can surface them without aborting.
 */
export async function cleanStaleHookEntries(
  settingsPath: string,
): Promise<CleanStaleResult> {
  const result: CleanStaleResult = {
    scanned: [settingsPath],
    cleaned: [],
    staleEntriesRemoved: 0,
    message: "",
  };

  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      result.message = `No settings at ${settingsPath} — nothing to migrate.`;
      return result;
    }
    result.message = `Cannot read ${settingsPath}: ${err?.message ?? err}`;
    return result;
  }

  let settings: Record<string, any>;
  try {
    settings = JSON.parse(raw);
  } catch {
    result.message = `Invalid JSON in ${settingsPath} — skipped (fix manually).`;
    return result;
  }

  const sections = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
  let removed = 0;

  for (const section of sections) {
    const arr = settings.hooks?.[section];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((entry: any) => {
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const hasStale = inner.some((h: any) =>
        isStaleTokenPilotHookCommand(h?.command),
      );
      if (hasStale) {
        removed++;
        return false;
      }
      return true;
    });
    if (filtered.length !== arr.length) {
      if (filtered.length === 0) {
        delete settings.hooks[section];
      } else {
        settings.hooks[section] = filtered;
      }
    }
  }

  if (removed === 0) {
    result.message = `No stale token-pilot hook entries in ${settingsPath}.`;
    return result;
  }

  // Drop empty hooks container so JSON stays clean.
  if (
    settings.hooks &&
    typeof settings.hooks === "object" &&
    Object.keys(settings.hooks).length === 0
  ) {
    delete settings.hooks;
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  result.cleaned.push(settingsPath);
  result.staleEntriesRemoved = removed;
  result.message = `Removed ${removed} stale token-pilot hook entr${
    removed === 1 ? "y" : "ies"
  } from ${settingsPath}.`;
  return result;
}

/**
 * Inspect `~/.claude/settings.json` to determine whether the user has
 * enabled the bundled `token-pilot` plugin in Claude Code. When true,
 * the plugin's own `hooks/hooks.json` is the source of truth and any
 * additional hook entries written by the npm CLI are duplicates that
 * also lock the user to whichever binary path the CLI captured.
 */
export async function isTokenPilotPluginEnabled(
  homeDir: string,
): Promise<boolean> {
  const settingsPath = resolve(homeDir, ".claude", "settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch {
    return false;
  }
  let settings: any;
  try {
    settings = JSON.parse(raw);
  } catch {
    return false;
  }
  const enabled = settings?.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return false;
  // keys look like `token-pilot@token-pilot` — match prefix.
  return Object.entries(enabled).some(
    ([key, val]) =>
      val === true && typeof key === "string" && key.startsWith("token-pilot@"),
  );
}
