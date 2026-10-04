/**
 * Config resolution without file or process access: defaults, the user's
 * `.token-pilot.json` object, hook-mode migration and env overrides. The CLI
 * (loader.ts) and the Claude Code mod both read the file themselves and
 * resolve it here, so they agree on every value.
 */

import type { HookMode, TokenPilotConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./defaults.js";

const VALID_HOOK_MODES: ReadonlySet<HookMode> = new Set([
  "off",
  "advisory",
  "deny-enhanced",
]);

/**
 * v0.39.3 — portable deep clone of the default config.
 *
 * The previous code used `structuredClone(DEFAULT_CONFIG)`, a global
 * added in Node 17. Despite `engines: ">=18"`, the engines field is
 * NOT enforced at runtime, and Claude Code spawns hooks with whatever
 * `node` is first on PATH. On machines with a system / nvm-default
 * Node 16 that resolved to v16.x, `loadConfig` threw
 * `ReferenceError: structuredClone is not defined` — caught in the
 * wild by the v0.33.0 error channel (hook-session-start, Node 16.17.1).
 * That throw killed every hook that calls loadConfig (read,
 * session-start, pre-bash, pre-grep) on those machines.
 *
 * DEFAULT_CONFIG is a plain JSON-serialisable object (no Dates, Maps,
 * functions, or cycles), so a JSON round-trip is a correct, fully
 * portable deep clone that works on every Node version.
 */
function cloneDefaults(): TokenPilotConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as TokenPilotConfig;
}

export function resolveConfig(
  userConfig: Record<string, unknown> | null,
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void = () => {},
): TokenPilotConfig {
  const merged = deepMerge(cloneDefaults(), userConfig ?? {}) as TokenPilotConfig;
  applyHookModeMigration(merged, userConfig ?? {}, warn);
  applyEnvOverrides(merged, env);

  return merged;
}

/**
 * Env-var overrides that the user can set without editing the config
 * file. Per TP-816 §7.3. Only integer-valued, positive numbers are
 * accepted; malformed values are ignored silently.
 */
function applyEnvOverrides(
  merged: TokenPilotConfig,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const raw = env.TOKEN_PILOT_DENY_THRESHOLD;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      merged.hooks.denyThreshold = n;
    }
  }
  const adaptive = env.TOKEN_PILOT_ADAPTIVE_THRESHOLD;
  if (adaptive !== undefined) {
    merged.hooks.adaptiveThreshold = /^(1|true|yes|on)$/i.test(adaptive.trim());
  }
  const budget = env.TOKEN_PILOT_ADAPTIVE_BUDGET;
  if (budget !== undefined) {
    const n = Number.parseInt(budget, 10);
    if (Number.isFinite(n) && n > 0) {
      merged.hooks.adaptiveBudgetTokens = n;
    }
  }
  // TOKEN_PILOT_MODE=advisory ("hooks always allow") and TOKEN_PILOT_BYPASS=1
  // switch the Read gate off too — it is the only gate hooks.mode governs.
  if (
    env.TOKEN_PILOT_MODE?.trim().toLowerCase() === "advisory" ||
    env.TOKEN_PILOT_BYPASS === "1"
  ) {
    merged.hooks.mode = "off";
  }
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
  warn: (message: string) => void,
): void {
  const userHooks = (userConfig.hooks ?? {}) as Record<string, unknown>;
  const userProvidedMode = typeof userHooks.mode === "string";
  const userSetEnabledFalse = userHooks.enabled === false;

  if (userProvidedMode && !VALID_HOOK_MODES.has(merged.hooks.mode)) {
    warn(
      `[token-pilot] Unknown hooks.mode "${merged.hooks.mode}". ` +
        `Valid values: off, advisory, deny-enhanced. Falling back to default "${DEFAULT_CONFIG.hooks.mode}".`,
    );
    merged.hooks.mode = DEFAULT_CONFIG.hooks.mode;
    return;
  }

  if (!userProvidedMode && userSetEnabledFalse) {
    warn(
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
