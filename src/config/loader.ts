import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TokenPilotConfig } from "../types.js";
import { resolveConfig } from "./resolve.js";



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
    return resolveConfig(null, {});
  }

  // Phase 6 subtask 6.4 — rewrite legacy `mode:"deny"` to `"advisory"`
  // before merge so downstream code (incl. applyHookModeMigration's
  // unknown-mode warning) sees the migrated value.
  await applyLegacyDenyMigration(configPath, userConfig ?? {});

  return resolveConfig(userConfig, process.env, (m) => console.error(m));
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


