import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const HOOK_CONFIG = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Read",
        hooks: [
          {
            type: "command" as const,
            command: "token-pilot hook-read $FILE_PATH",
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
export async function installHook(projectRoot: string): Promise<{ installed: boolean; message: string }> {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');

  try {
    // Ensure .claude dir exists
    await mkdir(dirname(settingsPath), { recursive: true });

    let settings: Record<string, any> = {};

    // Try to read existing settings
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw);
    } catch {
      // File doesn't exist or is invalid — start fresh
    }

    // Check if hook already exists
    const existingHooks = settings.hooks?.PreToolUse;
    if (Array.isArray(existingHooks)) {
      const hasTokenPilot = existingHooks.some((h: any) =>
        h.matcher === 'Read' &&
        h.hooks?.some((hook: any) => hook.command?.includes('token-pilot'))
      );

      if (hasTokenPilot) {
        return { installed: false, message: 'Token Pilot hook already installed.' };
      }

      // Add to existing PreToolUse hooks
      existingHooks.push(HOOK_CONFIG.hooks.PreToolUse[0]);
    } else {
      // Create hooks section
      if (!settings.hooks) settings.hooks = {};
      settings.hooks.PreToolUse = HOOK_CONFIG.hooks.PreToolUse;
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return {
      installed: true,
      message: `Hook installed at ${settingsPath}. Token Pilot will suggest smart_read for large code files.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { installed: false, message: `Failed to install hook: ${msg}` };
  }
}

/**
 * Remove Token Pilot hook from Claude Code settings.
 */
export async function uninstallHook(projectRoot: string): Promise<{ removed: boolean; message: string }> {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');

  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);

    if (!settings.hooks?.PreToolUse) {
      return { removed: false, message: 'No hooks to remove.' };
    }

    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((h: any) =>
      !(h.matcher === 'Read' && h.hooks?.some((hook: any) => hook.command?.includes('token-pilot')))
    );

    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return { removed: true, message: 'Token Pilot hook removed.' };
  } catch {
    return { removed: false, message: 'Settings file not found or invalid.' };
  }
}
