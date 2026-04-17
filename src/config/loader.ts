import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HookMode, TokenPilotConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./defaults.js";

const VALID_HOOK_MODES: ReadonlySet<HookMode> = new Set([
  "off",
  "advisory",
  "deny-enhanced",
]);

export async function loadConfig(
  projectRoot: string,
): Promise<TokenPilotConfig> {
  const configPath = resolve(projectRoot, ".token-pilot.json");

  let userConfig: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(configPath, "utf-8");
    userConfig = JSON.parse(raw);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error(
        `[token-pilot] Invalid config at ${configPath}: ${err?.message ?? err}. Using defaults.`,
      );
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  const merged = deepMerge(
    structuredClone(DEFAULT_CONFIG),
    userConfig ?? {},
  ) as TokenPilotConfig;

  applyHookModeMigration(merged, userConfig ?? {});

  return merged;
}

/**
 * Reconcile the new hooks.mode field with the legacy hooks.enabled boolean.
 * - Explicit user-provided mode wins (after validation).
 * - If user omitted mode but set enabled:false → migrate to mode:"off" with a
 *   deprecation notice (preserves v0.19 behaviour for users who actively
 *   turned the hook off).
 * - Unknown mode values fall back to the default with a warning.
 */
function applyHookModeMigration(
  merged: TokenPilotConfig,
  userConfig: Record<string, unknown>,
): void {
  const userHooks = (userConfig.hooks ?? {}) as Record<string, unknown>;
  const userProvidedMode = typeof userHooks.mode === "string";
  const userSetEnabledFalse = userHooks.enabled === false;

  if (userProvidedMode && !VALID_HOOK_MODES.has(merged.hooks.mode)) {
    console.error(
      `[token-pilot] Unknown hooks.mode "${merged.hooks.mode}". ` +
        `Valid values: off, advisory, deny-enhanced. Falling back to default "${DEFAULT_CONFIG.hooks.mode}".`,
    );
    merged.hooks.mode = DEFAULT_CONFIG.hooks.mode;
    return;
  }

  if (!userProvidedMode && userSetEnabledFalse) {
    console.error(
      `[token-pilot] hooks.enabled:false is deprecated — migrated to hooks.mode:"off". ` +
        `Update your .token-pilot.json to use hooks.mode explicitly.`,
    );
    merged.hooks.mode = "off";
  }
}

function deepMerge(
  target: Record<string, any>,
  source: Record<string, any>,
): Record<string, any> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      continue;
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}
