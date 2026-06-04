import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    return cloneDefaults();
  }

  // Phase 6 subtask 6.4 — rewrite legacy `mode:"deny"` to `"advisory"`
  // before merge so downstream code (incl. applyHookModeMigration's
  // unknown-mode warning) sees the migrated value.
  await applyLegacyDenyMigration(configPath, userConfig ?? {});

  const merged = deepMerge(
    cloneDefaults(),
    userConfig ?? {},
  ) as TokenPilotConfig;

  applyHookModeMigration(merged, userConfig ?? {});
  applyEnvOverrides(merged);

  return merged;
}

/**
 * Env-var overrides that the user can set without editing the config
 * file. Per TP-816 §7.3. Only integer-valued, positive numbers are
 * accepted; malformed values are ignored silently.
 */
function applyEnvOverrides(merged: TokenPilotConfig): void {
  const raw = process.env.TOKEN_PILOT_DENY_THRESHOLD;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      merged.hooks.denyThreshold = n;
    }
  }
  const adaptive = process.env.TOKEN_PILOT_ADAPTIVE_THRESHOLD;
  if (adaptive !== undefined) {
    merged.hooks.adaptiveThreshold = /^(1|true|yes|on)$/i.test(adaptive.trim());
  }
  const budget = process.env.TOKEN_PILOT_ADAPTIVE_BUDGET;
  if (budget !== undefined) {
    const n = Number.parseInt(budget, 10);
    if (Number.isFinite(n) && n > 0) {
      merged.hooks.adaptiveBudgetTokens = n;
    }
  }
}

/**
 * When a user's config still has `hooks.mode: "deny"` (the removed
 * v0.19 legacy value), rewrite it on disk to `"advisory"` and stamp
 * `hooks.migratedFrom: "deny"` so the stderr notice fires exactly once.
 *
 * Mutates `userConfig` in place so the caller's subsequent merge picks
 * up the new mode. Failures are swallowed — a broken rewrite must not
 * prevent the session from starting.
 */
async function applyLegacyDenyMigration(
  configPath: string,
  userConfig: Record<string, unknown>,
): Promise<void> {
  const hooks = (userConfig.hooks ?? {}) as Record<string, unknown>;
  if (hooks.mode !== "deny") return;
  if (hooks.migratedFrom === "deny") {
    // Already migrated at some point; user reverted mode manually.
    // Leave their choice alone — downstream unknown-mode path will
    // handle it (falls back to default with a warning).
    return;
  }

  hooks.mode = "advisory";
  hooks.migratedFrom = "deny";
  userConfig.hooks = hooks;

  console.error(
    `[token-pilot] Config migrated: hooks.mode "deny" is no longer valid in v0.20. ` +
      `Rewriting to "advisory" (strict superset of old behaviour is "deny-enhanced"; ` +
      `switch there manually when ready). Stamped hooks.migratedFrom:"deny" to silence this notice.`,
  );

  try {
    await writeFile(configPath, JSON.stringify(userConfig, null, 2) + "\n");
  } catch {
    /* ignore — migration is best-effort */
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
