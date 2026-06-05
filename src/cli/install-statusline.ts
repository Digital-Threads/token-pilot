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

/** The version-agnostic chain command (auto-picks the newest plugin dir). */
export const CHAIN_COMMAND =
  'bash "$(ls -t ~/.claude/plugins/cache/token-pilot/token-pilot/*/hooks/statusline-chain.sh 2>/dev/null | head -1)"';

export interface InstallStatuslineResult {
  action: "installed" | "upgraded" | "noop" | "skipped";
  message: string;
}

/**
 * Pure decision: given the current statusline status, what should the
 * installer do? Separated from I/O for unit tests.
 */
export function decideStatuslineAction(
  status: StatuslineStatus,
  force: boolean,
): { write: boolean; result: InstallStatuslineResult } {
  switch (status) {
    case "not-configured":
      return {
        write: true,
        result: {
          action: "installed",
          message:
            "statusLine configured — the [TP] badge will show in your status bar (restart Claude Code).",
        },
      };
    case "configured-caveman-only":
    case "configured-tp-only":
      return {
        write: true,
        result: {
          action: "upgraded",
          message:
            "statusLine upgraded to the chain wrapper — both caveman and [TP] badges now render side by side.",
        },
      };
    case "configured-chain":
      return {
        write: false,
        result: {
          action: "noop",
          message: "statusLine already uses the token-pilot chain wrapper. Nothing to do.",
        },
      };
    case "configured-other":
      if (force) {
        return {
          write: true,
          result: {
            action: "installed",
            message:
              "Replaced your custom statusLine with the token-pilot chain wrapper (--force).",
          },
        };
      }
      return {
        write: false,
        result: {
          action: "skipped",
          message:
            "You already have a custom statusLine — left untouched. " +
            "To show the [TP] badge too, set statusLine.command to:\n  " +
            CHAIN_COMMAND +
            "\nor re-run with --force to replace it.",
        },
      };
    case "unknown":
    default:
      return {
        write: false,
        result: {
          action: "skipped",
          message:
            "Could not read ~/.claude/settings.json as JSON — not modifying it. " +
            "Add this manually under \"statusLine\":\n  " +
            CHAIN_COMMAND,
        },
      };
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
  const settingsPath =
    opts?.settingsPath ?? join(homedir(), ".claude", "settings.json");

  const status = await classifyStatuslineAt(settingsPath);
  const { write, result } = decideStatuslineAction(status, force);

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

  settings.statusLine = { type: "command", command: CHAIN_COMMAND };

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
