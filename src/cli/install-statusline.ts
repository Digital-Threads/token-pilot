/**
 * v0.42.0 — `token-pilot install-statusline`.
 *
 * Convenience installer for the statusline badge. v0.41.1 removed the
 * intrusive sessionTitle overwrite and pointed users at the additive
 * statusline (hooks/statusline-chain.sh) — the caveman-style channel
 * that sits ALONGSIDE the session name and live-updates on every render.
 * This command wires it into `~/.claude/settings.json` without making
 * the user hand-edit JSON.
 *
 * Non-destructive by design (the sessionTitle lesson): we NEVER clobber
 * a third-party statusLine. Decision per current state:
 *
 *   not-configured        → write our chain command
 *   configured-caveman-only → upgrade to chain (shows BOTH badges)
 *   configured-tp-only    → upgrade to chain (so caveman shows too if present)
 *   configured-chain      → already ideal, no-op
 *   configured-other      → leave alone; print how to switch manually
 *   unknown               → settings.json unreadable; print guidance
 *
 * `--force` overrides the configured-other guard for users who really
 * want to replace a custom statusLine.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { StatuslineStatus } from "./ecosystem-check.js";

/** TP-only badge command (DEFAULT — just token-pilot's [TP] badge). */
export const TP_ONLY_COMMAND =
  'bash "$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/tp-statusline.sh 2>/dev/null | head -1)"';

/**
 * Chain command — renders token-pilot's badge AND any other ecosystem
 * badge (caveman) side by side. Opt-in via `--chain`.
 */
export const CHAIN_COMMAND =
  'bash "$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/statusline-chain.sh 2>/dev/null | head -1)"';

export interface InstallStatuslineResult {
  action: "installed" | "upgraded" | "noop" | "skipped";
  message: string;
}

export interface DecideStatuslineOpts {
  force: boolean;
  /** `--chain`: render caveman + [TP] together. Default false → [TP] only. */
  chain: boolean;
}

/**
 * Pure decision: given the current statusline status + options, what
 * should the installer do and which command should it write?
 *
 * v0.42.3 — DEFAULT is now the TP-only badge. The previous default
 * silently installed the chain wrapper, which also rendered caveman's
 * badge — presumptuous (we install OUR badge, we don't decide that a
 * third-party tool's badge belongs in your status bar). `--chain`
 * opts into the combined view. token-pilot's own previous choices
 * (tp-only ↔ chain) are switched freely; a non-token-pilot statusLine
 * (caveman-only, custom) is never clobbered without `--force`.
 */
export function decideStatuslineAction(
  status: StatuslineStatus,
  opts: DecideStatuslineOpts,
): { write: boolean; command: string; result: InstallStatuslineResult } {
  const command = opts.chain ? CHAIN_COMMAND : TP_ONLY_COMMAND;
  const badgeDesc = opts.chain ? "caveman + [TP] badges" : "[TP] badge";
  const noWrite = (action: InstallStatuslineResult["action"], message: string) => ({
    write: false,
    command,
    result: { action, message },
  });
  const doWrite = (action: InstallStatuslineResult["action"], message: string) => ({
    write: true,
    command,
    result: { action, message },
  });

  switch (status) {
    case "not-configured":
      return doWrite(
        "installed",
        `statusLine configured — the ${badgeDesc} will show in your status bar (restart Claude Code).`,
      );

    case "configured-tp-only":
      // Already ours. Switch only if the user asked for the chain.
      return opts.chain
        ? doWrite(
            "upgraded",
            "statusLine upgraded to the chain wrapper — caveman + [TP] now render side by side.",
          )
        : noWrite("noop", "statusLine already shows the [TP] badge. Nothing to do.");

    case "configured-chain":
      // Also ours. Switch to tp-only unless the user wants the chain.
      return opts.chain
        ? noWrite("noop", "statusLine already uses the chain wrapper. Nothing to do.")
        : doWrite(
            "installed",
            "statusLine switched to the [TP]-only badge (caveman badge removed from the status bar).",
          );

    case "configured-caveman-only":
      // Caveman's own statusline — NOT ours. Don't replace it silently.
      if (opts.chain) {
        return doWrite(
          "upgraded",
          "statusLine upgraded to the chain wrapper — keeps caveman and adds [TP].",
        );
      }
      if (opts.force) {
        return doWrite(
          "installed",
          "Replaced caveman's statusLine with the [TP]-only badge (--force).",
        );
      }
      return noWrite(
        "skipped",
        "Your statusLine is caveman's. Left untouched. Run with --chain to show " +
          "both badges, or --force to replace it with [TP] only.",
      );

    case "configured-other":
      if (opts.force) {
        return doWrite(
          "installed",
          `Replaced your custom statusLine with the ${badgeDesc} (--force).`,
        );
      }
      return noWrite(
        "skipped",
        "You already have a custom statusLine — left untouched. To use the " +
          `${badgeDesc}, re-run with --force, or set statusLine.command to:\n  ` +
          command,
      );

    case "unknown":
    default:
      return noWrite(
        "skipped",
        'Could not read ~/.claude/settings.json as JSON — not modifying it. ' +
          'Add this manually under "statusLine":\n  ' +
          command,
      );
  }
}

/**
 * Classify the statusLine state of a settings.json at `settingsPath`.
 * Async, path-injectable (so tests point at a tmp file). Mirrors
 * ecosystem-check.checkStatusline but works on any path. Never throws.
 */
export async function classifyStatuslineAt(
  settingsPath: string,
): Promise<StatuslineStatus> {
  try {
    await access(settingsPath);
  } catch {
    return "not-configured";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch {
    return "unknown";
  }
  const cmd = (parsed as { statusLine?: { command?: unknown } } | null)
    ?.statusLine?.command;
  if (typeof cmd !== "string") return "not-configured";
  if (cmd.includes("statusline-chain.sh")) return "configured-chain";
  if (cmd.includes("tp-statusline.sh")) return "configured-tp-only";
  if (cmd.includes("caveman-statusline.sh")) return "configured-caveman-only";
  return "configured-other";
}

/**
 * CLI entry. Returns an exit code.
 */
export async function handleInstallStatusline(
  argv: string[],
  opts?: { settingsPath?: string },
): Promise<number> {
  const force = argv.includes("--force");
  const chain = argv.includes("--chain");
  const settingsPath =
    opts?.settingsPath ?? join(homedir(), ".claude", "settings.json");

  const status = await classifyStatuslineAt(settingsPath);
  const { write, command, result } = decideStatuslineAction(status, {
    force,
    chain,
  });

  if (!write) {
    process.stdout.write(`[token-pilot] ${result.message}\n`);
    return 0;
  }

  // Merge the statusLine field into existing settings (preserve the rest).
  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    /* fresh file — start clean (only reached when status was safe) */
  }

  settings.statusLine = { type: "command", command };

  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `[token-pilot] failed to write ${settingsPath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  process.stdout.write(`[token-pilot] ${result.message}\n`);
  return 0;
}
