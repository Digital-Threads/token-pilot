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

function createHookConfig(options?: HookInstallOptions) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command" as const,
              command: buildHookCommand("hook-read", options),
            },
          ],
        },
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command" as const,
              command: buildHookCommand("hook-edit", options),
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: "command" as const,
              command: buildHookCommand("hook-session-start", options),
            },
          ],
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
  // the plugin system already registers hooks via .claude-plugin/hooks/hooks.json
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
      // and replace with working ones using absolute paths
      const oldBrokenHooks = existingHooks.filter(
        (h: any) =>
          isTokenPilotHook(h) &&
          h.hooks?.some(
            (hook: any) => hook.command?.match(/^token-pilot\s/), // bare command without path
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

        if (hasRead && hasEdit && hasSessionStart) {
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
    if (!hasPreToolUse && !hasSessionStart) {
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
