import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

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

const HOOK_CONFIG = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Read",
        hooks: [
          {
            type: "command" as const,
            command: "token-pilot hook-read",
          },
        ],
      },
      {
        matcher: "Edit",
        hooks: [
          {
            type: "command" as const,
            command: "token-pilot hook-edit",
          },
        ],
      },
    ],
  },
};

/**
 * Install Token Pilot hook into Claude Code settings.
 * Creates or updates .claude/settings.json with PreToolUse hook.
 */
export async function installHook(projectRoot: string): Promise<HookInstallResult> {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');

  try {
    // Ensure .claude dir exists
    await mkdir(dirname(settingsPath), { recursive: true });

    let settings: Record<string, any> = {};

    // Try to read existing settings
    try {
      const raw = await readFile(settingsPath, 'utf-8');
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
      if (err?.code !== 'ENOENT') {
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
      h.hooks?.some((hook: any) => hook.command?.includes('token-pilot'));

    if (Array.isArray(existingHooks)) {
      const hasRead = existingHooks.some((h: any) => h.matcher === 'Read' && isTokenPilotHook(h));
      const hasEdit = existingHooks.some((h: any) => h.matcher === 'Edit' && isTokenPilotHook(h));

      if (hasRead && hasEdit) {
        return { installed: false, fatal: false, message: 'Token Pilot hooks already installed.' };
      }

      // Add missing hooks
      for (const hookDef of HOOK_CONFIG.hooks.PreToolUse) {
        const exists = existingHooks.some((h: any) => h.matcher === hookDef.matcher && isTokenPilotHook(h));
        if (!exists) {
          existingHooks.push(hookDef);
        }
      }
    } else {
      // Create hooks section
      if (!settings.hooks) settings.hooks = {};
      settings.hooks.PreToolUse = HOOK_CONFIG.hooks.PreToolUse;
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return {
      installed: true,
      fatal: false,
      message: `Hooks installed at ${settingsPath}. Token Pilot will block unbounded Read on large code files and suggest read_for_edit before Edit.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { installed: false, fatal: true, message: `Failed to install hook: ${msg}` };
  }
}

/**
 * Remove Token Pilot hook from Claude Code settings.
 */
export async function uninstallHook(projectRoot: string): Promise<HookUninstallResult> {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');

  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);

    if (!settings.hooks?.PreToolUse) {
      return { removed: false, fatal: false, message: 'No hooks to remove.' };
    }

    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((h: any) =>
      !h.hooks?.some((hook: any) => hook.command?.includes('token-pilot'))
    );

    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return { removed: true, fatal: false, message: 'Token Pilot hook removed.' };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { removed: false, fatal: false, message: 'Settings file not found.' };
    }
    if (err instanceof SyntaxError) {
      return {
        removed: false,
        fatal: true,
        message: `Settings file contains invalid JSON: ${settingsPath}. Fix it manually before uninstalling hooks.`,
      };
    }
    return { removed: false, fatal: true, message: `Failed to process settings: ${err?.message ?? err}` };
  }
}
